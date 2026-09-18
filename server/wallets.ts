import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth, requirePerm, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Wallet pool = wallet_device_map (receiving wallets → device/sim), enriched
// with live device_status. Channels = local_deposit_channels (allocation config).

export const walletRoutes = new Hono<AuthEnv>()

walletRoutes.use('*', requireAuth)

walletRoutes.get('/live', requirePerm('wallets', 'can_view'), async (c) => {
  const old = oldDb()
  if (!old) return c.json({ live: [] })
  const { data, error } = await old.rpc('maven_banks_live_list')
  if (error) return c.json({ error: 'legacy_wallet_lookup_failed', detail: error.message }, 502)
  return c.json({ live: Array.isArray(data) ? data : [] })
})

// Maven has not exposed an endpoint to actually change which number receives
// customer funds (see the disclaimer on this table's "Change" action). This
// only records the operator's intent in the audit log so there is a paper
// trail to act on manually — it never touches routing.
walletRoutes.post('/live/replacement-request', requirePerm('wallets', 'can_edit'), async (c) => {
  const body = await c.req.json<{ bank_ids?: unknown; new_wallet_number?: unknown }>().catch(() => null)
  const bankIds = Array.isArray(body?.bank_ids)
    ? [...new Set(body.bank_ids.map((value) => String(value ?? '').trim()).filter(Boolean))]
    : []
  const newNumber = String(body?.new_wallet_number ?? '').replace(/\D/g, '')
  if (!bankIds.length || !/^\d{8,20}$/.test(newNumber)) return c.json({ error: 'invalid_replacement_request' }, 400)
  const actor = c.get('actor')
  await db.from('audit_log').insert({
    actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username,
    action: 'live_wallet_replacement_requested', entity: 'maven_live_wallet', entity_id: bankIds.join(','),
    after: { bank_ids: bankIds, requested_new_wallet_number: newNumber, note: 'Maven has not exposed a number-change API — recorded request only, no routing change made.' },
  })
  return c.json({ ok: true, bank_ids: bankIds, new_wallet_number: newNumber })
})

walletRoutes.get('/', requirePerm('wallets', 'can_view'), async (c) => {
  // Authoritative live wallet list straight from Maven (checked every few
  // minutes by the old system) — wallet_device_map is only the device
  // mapping and its auto-inferred rows go stale.
  const includeLive = c.req.query('include_live') !== 'false'
  const liveP = includeLive ? (async () => {
    const old = oldDb()
    if (!old) return []
    const { data } = await old.rpc('maven_banks_live_list')
    return Array.isArray(data) ? data : []
  })() : Promise.resolve([])

  const [wallets, devices, channels, live] = await Promise.all([
    db
      .from('wallet_device_map')
      .select('to_account_number, device, provider, confidence, auto_inferred, payment_type, daily_limit, merchant, sim_slot, updated_at')
      .order('provider')
      .order('to_account_number'),
    db
      .from('device_status')
      .select('device, sim_slot, sim_number, operator, battery, charging, net_type, online, balance, balance_at, last_seen_at'),
    db
      .from('local_deposit_channels')
      .select('id, channel_type, country_code, currency_code, display_name, active')
      .order('display_name'),
    liveP,
  ])
  if (wallets.error) return c.json({ error: 'db_error', detail: wallets.error.message }, 500)
  if (devices.error) return c.json({ error: 'db_error', detail: devices.error.message }, 500)
  if (channels.error) return c.json({ error: 'db_error', detail: channels.error.message }, 500)
  return c.json({
    live,
    wallets: wallets.data ?? [],
    devices: devices.data ?? [],
    channels: channels.data ?? [],
  })
})

// Import the currently active phone wallets reported by the legacy OnTarget
// source into the v2 wallet map. This is idempotent and never overwrites an
// operator's device assignment.
walletRoutes.post('/sync-live', requirePerm('wallets', 'can_edit'), async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 503)
  const { data, error } = await old.rpc('maven_banks_live_list')
  if (error) return c.json({ error: 'legacy_wallet_lookup_failed', detail: error.message }, 502)
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>
  const wallets = rows.map((row) => ({
    to_account_number: String(row.phone_number ?? '').replace(/\D/g, '').slice(-20),
    provider: String(row.account_name ?? row.bank_name ?? 'Mobile Wallet').slice(0, 80),
    payment_type: String(row.payment_type ?? 'Mobile Wallet').slice(0, 80),
    auto_inferred: true, confidence: 100, updated_at: new Date().toISOString(),
  })).filter((row) => /^\d{8,20}$/.test(row.to_account_number))
  if (!wallets.length) return c.json({ ok: true, imported: 0, source_count: rows.length })
  const result = await db.from('wallet_device_map').upsert(wallets, { onConflict: 'to_account_number', ignoreDuplicates: true })
  if (result.error) return c.json({ error: 'wallet_import_failed', detail: result.error.message }, 400)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'wallets.sync_live', entity: 'wallet_device_map', entity_id: 'bulk', after: { source_count: rows.length, imported: wallets.length } })
  return c.json({ ok: true, imported: wallets.length, source_count: rows.length })
})

// One-time/full migration from the legacy wallet map. Unlike sync-live, this
// includes retired and manually assigned numbers too; existing v2 rows are
// never overwritten so operator device/SIM assignments remain authoritative.
walletRoutes.post('/sync-all', requirePerm('wallets', 'can_edit'), async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 503)
  const { data, error } = await old.from('wallet_device_map').select('to_account_number, device, provider, payment_type, merchant, sim_slot, daily_limit, confidence, auto_inferred').limit(20_000)
  if (error) return c.json({ error: 'legacy_wallet_lookup_failed', detail: error.message }, 502)
  const rows = (data ?? []).map((row) => ({
    to_account_number: String(row.to_account_number ?? '').replace(/\D/g, '').slice(-20),
    device: typeof row.device === 'string' ? row.device : null,
    provider: typeof row.provider === 'string' ? row.provider : 'Mobile Wallet',
    payment_type: typeof row.payment_type === 'string' ? row.payment_type : 'Mobile Wallet',
    merchant: typeof row.merchant === 'string' ? row.merchant : null,
    sim_slot: Number.isInteger(row.sim_slot) ? row.sim_slot : null,
    daily_limit: Number.isFinite(Number(row.daily_limit)) ? Number(row.daily_limit) : null,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 100,
    auto_inferred: row.auto_inferred !== false,
    updated_at: new Date().toISOString(),
  })).filter((row) => /^\d{8,20}$/.test(row.to_account_number))
  if (!rows.length) return c.json({ ok: true, source_count: data?.length ?? 0, imported: 0 })
  const result = await db.from('wallet_device_map').upsert(rows, { onConflict: 'to_account_number', ignoreDuplicates: true })
  if (result.error) return c.json({ error: 'wallet_import_failed', detail: result.error.message }, 400)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'wallets.sync_all_legacy', entity: 'wallet_device_map', entity_id: 'bulk', after: { source_count: data?.length ?? 0, valid_rows: rows.length } })
  return c.json({ ok: true, source_count: data?.length ?? 0, imported: rows.length })
})

// Add a phone wallet manually. Device assignment is optional and can be
// configured later, so a new wallet can be used immediately for visibility.
walletRoutes.post('/', requirePerm('wallets', 'can_create'), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  const wallet = String(body?.wallet_number ?? '').replace(/\D/g, '')
  if (!/^\d{8,20}$/.test(wallet)) return c.json({ error: 'invalid_wallet_number' }, 400)
  const device = typeof body?.device === 'string' && body.device.trim() ? body.device.trim().slice(0, 80) : null
  const simSlot = body?.sim_slot == null || body.sim_slot === '' ? null : Number(body.sim_slot)
  if (simSlot != null && (!Number.isInteger(simSlot) || simSlot < 0)) return c.json({ error: 'invalid_sim_slot' }, 400)
  const row = { to_account_number: wallet, provider: typeof body?.provider === 'string' ? body.provider.trim().slice(0, 80) || 'Mobile Wallet' : 'Mobile Wallet', payment_type: 'Mobile Wallet', merchant: typeof body?.merchant === 'string' ? body.merchant.trim().slice(0, 120) || null : null, device, sim_slot: simSlot, auto_inferred: false, confidence: 100, daily_limit: Number.isFinite(Number(body?.daily_limit)) && Number(body?.daily_limit) > 0 ? Number(body?.daily_limit) : null, updated_at: new Date().toISOString() }
  const { data, error } = await db.from('wallet_device_map').insert(row).select('to_account_number, device, provider, payment_type, merchant, sim_slot, daily_limit, auto_inferred, confidence, updated_at').single()
  if (error) return c.json({ error: error.code === '23505' ? 'wallet_already_exists' : 'wallet_create_failed', detail: error.message }, 400)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'wallet_created', entity: 'wallet_device_map', entity_id: wallet, after: row })
  return c.json({ ok: true, wallet: data }, 201)
})

const ENGINE_DAILY_CAP = 60_000
const ENGINE_MONTHLY_CAP = 200_000
const COMMITTED_STATUSES = new Set(['PENDING', 'PAID', 'APPROVED', 'SUCCESS', 'COMPLETED'])

type AllocationStrategy = 'lowest_usage' | 'priority' | 'dedicated_merchant' | 'smart_split'

function walletKey(value: unknown) {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length > 11 ? digits.slice(-11) : digits
}

function cairoBoundary(day: 1 | 'today') {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const year = value('year')
  const month = value('month')
  const date = day === 1 ? 1 : value('day')
  const guess = Date.UTC(year, month - 1, date)
  const zoneParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess))
  const zoneValue = (type: string) => Number(zoneParts.find((part) => part.type === type)?.value)
  const represented = Date.UTC(zoneValue('year'), zoneValue('month') - 1, zoneValue('day'), zoneValue('hour'), zoneValue('minute'), zoneValue('second'))
  return new Date(guess - (represented - guess)).toISOString()
}

// Read-only, deterministic allocation simulation. It never reserves a wallet
// and never modifies checkout routing.
walletRoutes.post('/allocation/simulate', requirePerm('wallets', 'can_view'), async (c) => {
  const body = await c.req.json<{ amount?: number | string; strategy?: AllocationStrategy; merchant?: string }>().catch(() => null)
  const amount = Number(body?.amount)
  const strategy = body?.strategy
  const merchant = body?.merchant?.trim() ?? ''
  const strategies: AllocationStrategy[] = ['lowest_usage', 'priority', 'dedicated_merchant', 'smart_split']
  if (!Number.isFinite(amount) || amount <= 0 || !strategy || !strategies.includes(strategy)) {
    return c.json({ error: 'invalid_allocation_input' }, 400)
  }
  if (amount > ENGINE_MONTHLY_CAP) return c.json({ error: 'amount_exceeds_monthly_cap', cap: ENGINE_MONTHLY_CAP }, 400)
  if (strategy === 'dedicated_merchant' && !merchant) return c.json({ error: 'merchant_required' }, 400)

  const monthStart = cairoBoundary(1)
  const dayStart = cairoBoundary('today')
  const livePromise = (async () => {
    const old = oldDb()
    if (!old) return []
    const { data } = await old.rpc('maven_banks_live_list')
    return Array.isArray(data) ? data as { phone_number?: string | null }[] : []
  })()
  const [wallets, devices, accounts, transactions, sms, liveWallets] = await Promise.all([
    db.from('wallet_device_map').select('to_account_number, device, provider, confidence, payment_type, daily_limit, merchant, sim_slot, enrich_priority, updated_at'),
    db.from('device_status').select('device, sim_slot, online, balance, balance_at, last_seen_at'),
    db.from('payment_accounts').select('account_number, current_balance, balance_updated_at, is_active'),
    db.from('maven_transactions').select('amount, status, receiving_wallet, to_account_number, first_seen_at').gte('first_seen_at', monthStart).limit(20_000),
    db.from('inbound_sms').select('receiver_number, wallet_number, matched, match_status, received_at').eq('matched', true).order('received_at', { ascending: false }).limit(5_000),
    livePromise,
  ])
  const failure = [wallets, devices, accounts, transactions, sms].find((result) => result.error)
  if (failure?.error) return c.json({ error: 'db_error', detail: failure.error.message }, 500)

  const deviceMap = new Map<string, (typeof devices.data extends (infer T)[] | null ? T : never)>()
  for (const device of devices.data ?? []) deviceMap.set(`${device.device}#${device.sim_slot ?? 0}`, device)
  const accountMap = new Map((accounts.data ?? []).map((account) => [walletKey(account.account_number), account]))
  const liveSet = new Set(liveWallets.map((wallet) => walletKey(wallet.phone_number)).filter(Boolean))
  const usage = new Map<string, { daily: number; monthly: number }>()
  for (const tx of transactions.data ?? []) {
    if (!COMMITTED_STATUSES.has(String(tx.status ?? '').toUpperCase())) continue
    const key = walletKey(tx.receiving_wallet || tx.to_account_number)
    if (!key) continue
    const current = usage.get(key) ?? { daily: 0, monthly: 0 }
    const value = Number(tx.amount) || 0
    current.monthly += value
    if (tx.first_seen_at && tx.first_seen_at >= dayStart) current.daily += value
    usage.set(key, current)
  }
  const lastSms = new Map<string, string>()
  for (const row of sms.data ?? []) {
    const key = walletKey(row.receiver_number || row.wallet_number)
    if (key && row.received_at && !lastSms.has(key)) lastSms.set(key, row.received_at)
  }

  const now = Date.now()
  const candidates = (wallets.data ?? []).map((wallet) => {
    const key = walletKey(wallet.to_account_number)
    const device = deviceMap.get(`${wallet.device}#${wallet.sim_slot ?? 0}`) ??
      (devices.data ?? []).find((row) => row.device === wallet.device)
    const account = accountMap.get(key)
    const used = usage.get(key) ?? { daily: 0, monthly: 0 }
    const configuredDaily = Number(wallet.daily_limit)
    const dailyCap = configuredDaily > 0 ? Math.min(configuredDaily, ENGINE_DAILY_CAP) : ENGINE_DAILY_CAP
    const lastSeenAge = device?.last_seen_at ? now - new Date(device.last_seen_at).getTime() : Infinity
    const health = liveSet.has(key) || (device?.online && lastSeenAge <= 15 * 60_000) ? 'healthy'
      : device?.online ? 'degraded' : device ? 'offline' : 'unknown'
    const retired = /retired|replaced_by/i.test(`${wallet.to_account_number} ${wallet.merchant ?? ''}`)
    const dedicatedMatch = merchant !== '' && (wallet.merchant ?? '').toLowerCase().includes(merchant.toLowerCase())
    const reasons: string[] = []
    if (retired) reasons.push('retired_wallet')
    if (account?.is_active === false) reasons.push('inactive_account')
    if (health !== 'healthy') reasons.push(`health_${health}`)
    if (used.daily + (strategy === 'smart_split' ? 0.01 : amount) > dailyCap) reasons.push('daily_cap_exceeded')
    if (used.monthly + (strategy === 'smart_split' ? 0.01 : amount) > ENGINE_MONTHLY_CAP) reasons.push('monthly_cap_exceeded')
    if (strategy === 'dedicated_merchant' && !dedicatedMatch) reasons.push('merchant_mismatch')
    const dailyRatio = used.daily / dailyCap
    const monthlyRatio = used.monthly / ENGINE_MONTHLY_CAP
    const healthPenalty = health === 'healthy' ? 0 : health === 'degraded' ? 1 : 2
    const priority = wallet.enrich_priority ?? 999
    const smartScore = Math.max(dailyRatio, monthlyRatio) * 100 + healthPenalty * 100 + Math.min(priority, 999) / 1000
    return {
      wallet_number: wallet.to_account_number,
      provider: wallet.provider ?? wallet.payment_type,
      merchant: wallet.merchant,
      device: wallet.device,
      sim_slot: wallet.sim_slot,
      priority,
      balance: Number(account?.current_balance ?? device?.balance ?? 0),
      balance_updated_at: account?.balance_updated_at ?? device?.balance_at ?? null,
      daily_usage: used.daily,
      monthly_usage: used.monthly,
      daily_cap: dailyCap,
      monthly_cap: ENGINE_MONTHLY_CAP,
      daily_remaining: Math.max(0, dailyCap - used.daily),
      monthly_remaining: Math.max(0, ENGINE_MONTHLY_CAP - used.monthly),
      health,
      last_seen_at: device?.last_seen_at ?? null,
      last_sms_match: lastSms.get(key) ?? null,
      eligible: reasons.length === 0,
      rejection_reasons: reasons,
      dedicated_match: dedicatedMatch,
      smart_score: smartScore,
    }
  })

  const eligible = candidates.filter((candidate) => candidate.eligible)
  const walletTie = (a: typeof candidates[number], b: typeof candidates[number]) => a.wallet_number.localeCompare(b.wallet_number)
  if (strategy === 'lowest_usage') eligible.sort((a, b) => (a.daily_usage / a.daily_cap) - (b.daily_usage / b.daily_cap) || (a.monthly_usage / a.monthly_cap) - (b.monthly_usage / b.monthly_cap) || walletTie(a, b))
  if (strategy === 'priority' || strategy === 'dedicated_merchant') eligible.sort((a, b) => a.priority - b.priority || (a.daily_usage / a.daily_cap) - (b.daily_usage / b.daily_cap) || walletTie(a, b))
  if (strategy === 'smart_split') eligible.sort((a, b) => a.smart_score - b.smart_score || walletTie(a, b))

  let remaining = amount
  const allocations: { wallet_number: string; amount: number }[] = []
  for (const candidate of eligible) {
    const available = Math.min(candidate.daily_remaining, candidate.monthly_remaining)
    const allocation = strategy === 'smart_split' ? Math.min(remaining, available) : (available >= amount ? amount : 0)
    if (allocation > 0) allocations.push({ wallet_number: candidate.wallet_number, amount: allocation })
    remaining -= allocation
    if (remaining <= 0 || strategy !== 'smart_split') break
  }
  if (remaining > 0) allocations.length = 0

  return c.json({
    simulation: true,
    deterministic: true,
    amount,
    strategy,
    merchant: merchant || null,
    caps: { daily: ENGINE_DAILY_CAP, monthly: ENGINE_MONTHLY_CAP },
    selected: allocations.length ? eligible.find((candidate) => candidate.wallet_number === allocations[0].wallet_number) ?? null : null,
    allocations,
    unallocated_amount: allocations.length ? Math.max(0, remaining) : amount,
    candidates,
    evaluated_at: new Date().toISOString(),
  })
})

// Controlled NGPay wallet-number replacement. The wallet map uses the phone
// number as its primary key, so this endpoint deliberately refuses to merge
// rows into an existing number. The UI can therefore bulk-edit a selection
// without silently deleting device/SIM mappings.
walletRoutes.post('/ngpay/bulk-replace', requirePerm('wallets', 'can_edit'), async (c) => {
  const body = await c.req.json<{ wallet_numbers?: unknown; new_wallet_number?: unknown; merge?: unknown }>().catch(() => null)
  const walletNumbers = Array.isArray(body?.wallet_numbers)
    ? [...new Set(body.wallet_numbers.map((value) => String(value ?? '').replace(/\D/g, '')).filter((value) => /^\d{8,20}$/.test(value)))]
    : []
  const newWallet = String(body?.new_wallet_number ?? '').replace(/\D/g, '')
  if (!walletNumbers.length || !/^\d{8,20}$/.test(newWallet)) return c.json({ error: 'invalid_ngpay_bulk_replace' }, 400)

  const { data: rows, error: readError } = await db
    .from('wallet_device_map')
    .select('to_account_number, device, provider, payment_type, merchant, sim_slot, daily_limit, confidence, auto_inferred, updated_at')
    .in('to_account_number', walletNumbers)
    .eq('merchant', 'NGPay-MelBet-Prod')
  if (readError) return c.json({ error: 'db_error', detail: readError.message }, 500)

  const found = rows ?? []
  const missing = walletNumbers.filter((number) => !found.some((row) => row.to_account_number === number))
  if (body?.merge === true) {
    const { data, error } = await db.rpc('merge_ngpay_wallets', {
      p_wallet_numbers: walletNumbers,
      p_new_wallet: newWallet,
      p_actor: c.get('actor').username,
    })
    if (error) return c.json({ error: 'ngpay_merge_failed', detail: error.message, missing }, 409)
    return c.json({ ok: true, merged: data, missing })
  }
  const conflicts = found.filter((row) => row.to_account_number !== newWallet && walletNumbers.length > 1 && newWallet === row.to_account_number)
  if (conflicts.length) return c.json({ error: 'replacement_conflicts', detail: 'The target number is already one of the selected wallet keys.', conflicts }, 409)

  const existing = await db.from('wallet_device_map').select('to_account_number, device, merchant').eq('to_account_number', newWallet).maybeSingle()
  if (existing.error) return c.json({ error: 'db_error', detail: existing.error.message }, 500)
  if (existing.data && !walletNumbers.includes(newWallet)) {
    return c.json({ error: 'target_wallet_exists', detail: 'The target number already exists. Select that row instead of merging it.', target: existing.data }, 409)
  }
  if (found.length !== 1) {
    return c.json({
      error: 'bulk_merge_requires_confirmation',
      detail: 'Several NGPay rows cannot share one primary-key wallet number. Update one row at a time or use the dedicated merge workflow.',
      found: found.length,
      missing,
      target: newWallet,
    }, 409)
  }

  const row = found[0]
  const { data: updated, error: updateError } = await db.from('wallet_device_map')
    .update({ to_account_number: newWallet, auto_inferred: false, confidence: 100, updated_at: new Date().toISOString(), merchant: 'NGPay-MelBet-Prod' })
    .eq('to_account_number', row.to_account_number)
    .select('to_account_number, device, provider, payment_type, merchant, sim_slot, daily_limit, confidence, auto_inferred, updated_at')
    .single()
  if (updateError) return c.json({ error: updateError.code === '23505' ? 'target_wallet_exists' : 'wallet_replace_failed', detail: updateError.message }, 409)

  const actor = c.get('actor')
  await Promise.all([
    db.from('wallet_device_history').insert({ wallet_number: newWallet, device: row.device, sim_slot: row.sim_slot, changed_by: actor.username, note: `NGPay number replaced from ${row.to_account_number}` }),
    db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'ngpay_wallet_number_replaced', entity: 'wallet_device_map', entity_id: newWallet, before: row, after: updated }),
  ]).catch(() => {})
  return c.json({ ok: true, updated, missing })
})

walletRoutes.post('/:walletNumber/assignment', requirePerm('wallets', 'can_edit'), async (c) => {
  const walletNumber = decodeURIComponent(c.req.param('walletNumber')).trim()
  const body = await c.req.json<{ device?: string; sim_slot?: number | null; note?: string }>().catch(() => null)
  const device = body?.device?.trim()
  const simSlot = body?.sim_slot == null ? null : Number(body.sim_slot)

  if (!walletNumber || !device || (simSlot != null && (!Number.isInteger(simSlot) || simSlot < 0))) {
    return c.json({ error: 'invalid_assignment' }, 400)
  }

  const { data: targetDevice, error: deviceError } = await db
    .from('device_status')
    .select('device, sim_slot')
    .eq('device', device)
    .eq('sim_slot', simSlot ?? 0)
    .maybeSingle()
  if (deviceError) return c.json({ error: 'db_error', detail: deviceError.message }, 500)
  if (!targetDevice) return c.json({ error: 'unknown_device' }, 404)

  const { data: before, error: beforeError } = await db
    .from('wallet_device_map')
    .select('to_account_number, device, sim_slot')
    .eq('to_account_number', walletNumber)
    .maybeSingle()
  if (beforeError) return c.json({ error: 'db_error', detail: beforeError.message }, 500)
  if (!before) return c.json({ error: 'wallet_not_found' }, 404)

  const { error: updateError } = await db
    .from('wallet_device_map')
    .update({
      device,
      sim_slot: simSlot,
      auto_inferred: false,
      confidence: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('to_account_number', walletNumber)
  if (updateError) return c.json({ error: 'db_error', detail: updateError.message }, 500)

  // Keep the reassignment traceable without failing a completed mapping when
  // optional audit/history tables are unavailable in an older environment.
  await Promise.all([
    db.from('wallet_device_history').insert({
      wallet_number: walletNumber,
      device,
      sim_slot: simSlot,
      changed_by: c.get('actor').username,
      note: body?.note?.trim() || `Reassigned from ${before.device ?? 'unassigned'}`,
    }),
    db.from('audit_log').insert({
      actor_type: 'panel_user',
      actor_name: c.get('actor').username,
      action: 'wallet_device_reassigned',
      entity: 'wallet_device_map',
      entity_id: walletNumber,
      before: { device: before.device, sim_slot: before.sim_slot },
      after: { device, sim_slot: simSlot },
    }),
  ]).catch(() => {})

  return c.json({ ok: true, wallet: walletNumber, device, sim_slot: simSlot })
})
// ---- Wallet movements: money in and out per wallet, both directions ----
//
// Served from the old project: inbound_sms lives there and is not part of the
// delta sync, so reading a copy here would report on a fraction of the traffic.
//
// The report groups on inbound_sms.wallet_number, not receiver_number. Those
// agree on deposits but not on withdrawals, where receiver_number holds the
// customer being paid rather than the wallet paying them — 121 of 150
// withdrawals in a 7-day sample. Grouped the old way, money leaving a wallet
// was filed under a stranger's phone number.
// ---- Wallet rotation groups: display-only priority rotation ----
//
// enrich_priority only feeds /allocation/simulate above — it never changes
// which wallet Maven actually routes customer funds to (Maven has not
// exposed that API yet). A rotation group is therefore an internal ordering
// aid, not a live routing control; the /api/cron/wallet-rotation job
// advances it every 5 minutes.
walletRoutes.get('/rotation-groups', requirePerm('wallets', 'can_view'), async (c) => {
  const { data, error } = await db
    .from('wallet_rotation_groups')
    .select('id, wallet_numbers, mode, interval_minutes, amount_threshold, current_index, last_rotated_at, amount_received_since_rotation, active, created_by, created_at')
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ groups: data ?? [] })
})

walletRoutes.post('/rotation-groups', requirePerm('wallets', 'can_edit'), async (c) => {
  const body = await c.req.json<{ wallet_numbers?: unknown; mode?: unknown; interval_minutes?: unknown; amount_threshold?: unknown }>().catch(() => null)
  const wallets = Array.isArray(body?.wallet_numbers)
    ? [...new Set(body.wallet_numbers.map((value) => String(value ?? '').replace(/\D/g, '')).filter((value) => /^\d{8,20}$/.test(value)))]
    : []
  if (wallets.length < 2) return c.json({ error: 'at_least_two_wallets_required' }, 400)
  const mode = body?.mode === 'amount' ? 'amount' : body?.mode === 'time' ? 'time' : null
  if (!mode) return c.json({ error: 'invalid_mode' }, 400)
  const intervalMinutes = mode === 'time' ? Number(body?.interval_minutes) : null
  const amountThreshold = mode === 'amount' ? Number(body?.amount_threshold) : null
  if (mode === 'time' && (!Number.isFinite(intervalMinutes) || (intervalMinutes ?? 0) <= 0)) return c.json({ error: 'invalid_interval_minutes' }, 400)
  if (mode === 'amount' && (!Number.isFinite(amountThreshold) || (amountThreshold ?? 0) <= 0)) return c.json({ error: 'invalid_amount_threshold' }, 400)

  const { data: existing, error: existingError } = await db.from('wallet_device_map').select('to_account_number').in('to_account_number', wallets)
  if (existingError) return c.json({ error: 'db_error', detail: existingError.message }, 500)
  const missing = wallets.filter((wallet) => !(existing ?? []).some((row) => row.to_account_number === wallet))
  if (missing.length) return c.json({ error: 'unknown_wallets', missing }, 400)

  const actor = c.get('actor')
  const { data, error } = await db.from('wallet_rotation_groups').insert({
    wallet_numbers: wallets,
    mode,
    interval_minutes: intervalMinutes,
    amount_threshold: amountThreshold,
    created_by: actor.username,
  }).select('id, wallet_numbers, mode, interval_minutes, amount_threshold, current_index, last_rotated_at, amount_received_since_rotation, active, created_by, created_at').single()
  if (error) return c.json({ error: 'rotation_group_create_failed', detail: error.message }, 400)
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'wallet_rotation_group_created', entity: 'wallet_rotation_groups', entity_id: data.id, after: data })
  return c.json({ ok: true, group: data }, 201)
})

walletRoutes.patch('/rotation-groups/:id', requirePerm('wallets', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ active?: unknown }>().catch(() => null)
  if (typeof body?.active !== 'boolean') return c.json({ error: 'invalid_patch' }, 400)
  const { data, error } = await db.from('wallet_rotation_groups').update({ active: body.active, updated_at: new Date().toISOString() }).eq('id', id)
    .select('id, wallet_numbers, mode, interval_minutes, amount_threshold, current_index, last_rotated_at, amount_received_since_rotation, active, created_by, created_at').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'rotation_group_not_found' }, 404)
  return c.json({ ok: true, group: data })
})

walletRoutes.delete('/rotation-groups/:id', requirePerm('wallets', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const { error } = await db.from('wallet_rotation_groups').delete().eq('id', id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ ok: true })
})

walletRoutes.get(
  '/movements',
  requireAnyPerm(['wallets', 'treasury', 'reports', 'sms_live'], 'can_view'),
  async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 7, 0.5), 90)
    const old = oldDb()
    if (!old) return c.json({ error: 'old_db_not_configured' }, 503)
    const { data, error } = await old.rpc('wallet_movements', { p_days: days })
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    return c.json(data)
  },
)
