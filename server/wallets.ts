import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth, requirePerm, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Wallet pool = wallet_device_map (receiving wallets → device/sim), enriched
// with live device_status. Channels = local_deposit_channels (allocation config).

export const walletRoutes = new Hono<AuthEnv>()

walletRoutes.use('*', requireAuth)

walletRoutes.get('/', requirePerm('wallets', 'can_view'), async (c) => {
  // Authoritative live wallet list straight from Maven (checked every few
  // minutes by the old system) — wallet_device_map is only the device
  // mapping and its auto-inferred rows go stale.
  const liveP = (async () => {
    const old = oldDb()
    if (!old) return []
    const { data } = await old.rpc('maven_banks_live_list')
    return Array.isArray(data) ? data : []
  })()

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
