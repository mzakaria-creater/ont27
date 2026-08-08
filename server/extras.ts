import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// The remaining §5 module pages, one route each. Sensitive columns
// (api_key, secret_hash, password_hash, raw_profile, tokens) are NEVER selected.

export const extraRoutes = new Hono<AuthEnv>()

extraRoutes.use('*', requireAuth)

const DEPOSIT_COLS =
  'tx_id, ontarget_ref, merchant_tx_reference, status, amount, currency, sender_name, sender_number, payment_method, gateway, merchant, master_merchant, approved_by, first_seen_at, created_utc'
const PAYOUT_COLS =
  'maven_id, ontarget_ref, status, amount, pay_by, merchant, account_name, mobile_no, agent_name, approved_by, first_seen_at, created_utc'

// ---- Unified transactions (deposits + payouts) ----
extraRoutes.get(
  '/transactions',
  requireAnyPerm(['transactions', 'all_transactions', 'refunds', 'reversals'], 'can_view'),
  async (c) => {
    const type = c.req.query('type') // deposit | payout | ''
    const status = c.req.query('status')?.toUpperCase()
    const q = c.req.query('q')?.trim()
    const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const fetchTo = offset + limit

    const depQuery = () => {
      let query = db
        .from('maven_transactions')
        .select(DEPOSIT_COLS, { count: 'exact' })
        .order('ontarget_ref', { ascending: false, nullsFirst: false })
        .range(0, fetchTo - 1)
      if (status) query = query.eq('status', status)
      if (q) {
        const like = `%${q.replaceAll(',', ' ')}%`
        const ors = [`ontarget_ref.ilike.${like}`, `sender_number.ilike.${like}`, `sender_name.ilike.${like}`, `merchant.ilike.${like}`]
        if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
        query = query.or(ors.join(','))
      }
      return query
    }
    const payQuery = () => {
      let query = db
        .from('maven_payout_transactions')
        .select(PAYOUT_COLS, { count: 'exact' })
        .order('ontarget_ref', { ascending: false, nullsFirst: false })
        .range(0, fetchTo - 1)
      if (status) query = query.eq('status', status)
      if (q) {
        const like = `%${q.replaceAll(',', ' ')}%`
        const ors = [`ontarget_ref.ilike.${like}`, `mobile_no.ilike.${like}`, `account_name.ilike.${like}`, `merchant.ilike.${like}`]
        if (/^\d+$/.test(q)) ors.push(`maven_id.eq.${q}`)
        query = query.or(ors.join(','))
      }
      return query
    }

    const wantDep = type !== 'payout'
    const wantPay = type !== 'deposit'
    const [dep, pay] = await Promise.all([
      wantDep ? depQuery() : Promise.resolve({ data: [], count: 0, error: null }),
      wantPay ? payQuery() : Promise.resolve({ data: [], count: 0, error: null }),
    ])
    if (dep.error) return c.json({ error: 'db_error', detail: dep.error.message }, 500)
    if (pay.error) return c.json({ error: 'db_error', detail: pay.error.message }, 500)

    const rows = ([
      ...((dep.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({ ...r, kind: 'deposit' })),
      ...((pay.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({ ...r, kind: 'payout' })),
    ] as Record<string, unknown>[]).sort((a, b) =>
      String(b.ontarget_ref ?? '').localeCompare(String(a.ontarget_ref ?? '')),
    )

    return c.json({
      rows: rows.slice(offset, offset + limit),
      total: (dep.count ?? 0) + (pay.count ?? 0),
      limit,
      offset,
    })
  },
)

// ---- Approvals queue (everything PENDING) ----
extraRoutes.get(
  '/approvals',
  requireAnyPerm(['approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me'], 'can_view'),
  async (c) => {
    const [dep, pay] = await Promise.all([
      db
        .from('maven_transactions')
        .select(DEPOSIT_COLS)
        .eq('status', 'PENDING')
        .order('ontarget_ref', { ascending: false, nullsFirst: false })
        .limit(100),
      db
        .from('maven_payout_transactions')
        .select(PAYOUT_COLS)
        .eq('status', 'PENDING')
        .order('ontarget_ref', { ascending: false, nullsFirst: false })
        .limit(100),
    ])
    if (dep.error) return c.json({ error: 'db_error', detail: dep.error.message }, 500)
    if (pay.error) return c.json({ error: 'db_error', detail: pay.error.message }, 500)
    return c.json({ deposits: dep.data ?? [], payouts: pay.data ?? [] })
  },
)

// ---- Settlements: per-merchant aggregates over a window ----
extraRoutes.get(
  '/settlements',
  requireAnyPerm(['settlements', 'settlements_list', 'settlement_recon', 'fees'], 'can_view'),
  async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 7, 1), 90)
    const since = new Date(Date.now() - days * 86_400_000).toISOString()

    const [dep, pay] = await Promise.all([
      db
        .from('maven_transactions')
        .select('merchant, master_merchant, amount, commission, fees, currency')
        .in('status', ['PAID', 'APPROVED'])
        .gte('first_seen_at', since)
        .limit(10_000),
      db
        .from('maven_payout_transactions')
        .select('merchant, amount, commission')
        .eq('status', 'APPROVED')
        .gte('first_seen_at', since)
        .limit(10_000),
    ])
    if (dep.error) return c.json({ error: 'db_error', detail: dep.error.message }, 500)
    if (pay.error) return c.json({ error: 'db_error', detail: pay.error.message }, 500)

    interface Agg {
      merchant: string
      master: string | null
      depCount: number
      depVolume: number
      fees: number
      commission: number
      payCount: number
      payVolume: number
    }
    const byMerchant = new Map<string, Agg>()
    const get = (merchant: string | null, master: string | null): Agg => {
      const key = merchant ?? '—'
      if (!byMerchant.has(key)) {
        byMerchant.set(key, { merchant: key, master, depCount: 0, depVolume: 0, fees: 0, commission: 0, payCount: 0, payVolume: 0 })
      }
      return byMerchant.get(key)!
    }
    for (const r of dep.data ?? []) {
      const a = get(r.merchant, r.master_merchant)
      a.depCount += 1
      a.depVolume += Number(r.amount ?? 0)
      a.fees += Number(r.fees ?? 0)
      a.commission += Number(r.commission ?? 0)
    }
    for (const r of pay.data ?? []) {
      const a = get(r.merchant, null)
      a.payCount += 1
      a.payVolume += Number(r.amount ?? 0)
      a.commission += Number(r.commission ?? 0)
    }
    const rows = [...byMerchant.values()].sort((a, b) => b.depVolume - a.depVolume)
    return c.json({ days, rows })
  },
)

// ---- CRM clients ----
extraRoutes.get('/crm', requirePerm('client_crm', 'can_view'), async (c) => {
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  let query = db
    .from('crm_clients')
    .select(
      'id, client_name, phone_no, normalized_phone, merchant_name, first_transaction_at, last_transaction_at, total_deposit, approved_deposit, total_transactions, approved_transactions, declined_transactions, approval_rate, risk_score, is_vip, is_repeat_client, needs_review',
      { count: 'exact' },
    )
    .order('last_transaction_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)
  if (q) {
    const like = `%${q}%`
    query = query.or([`client_name.ilike.${like}`, `phone_no.ilike.${like}`, `normalized_phone.ilike.${like}`, `merchant_name.ilike.${like}`].join(','))
  }
  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0, limit, offset })
})

// ---- Risk: blacklist + suspicious SMS + clients flagged for review ----
extraRoutes.get(
  '/risk',
  requireAnyPerm(['risk', 'risk_audit', 'flagged', 'exceptions', 'manual_review', 'velocity', 'compliance'], 'can_view'),
  async (c) => {
    const [blacklist, sms, clients] = await Promise.all([
      db.from('api_risk_blacklist').select('id, merchant_id, type, value, reason, created_at').order('created_at', { ascending: false }).limit(100),
      db
        .from('inbound_sms')
        .select('id, received_at, device_name, sender_name, sender_number, receiver_number, amount, risk_score, risk_reason, suspicious, is_duplicate, sms_category')
        .or('suspicious.eq.true,risk_score.gt.0,is_duplicate.eq.true')
        .order('received_at', { ascending: false, nullsFirst: false })
        .limit(50),
      db
        .from('crm_clients')
        .select('id, client_name, phone_no, merchant_name, risk_score, approval_rate, total_transactions, needs_review')
        .eq('needs_review', true)
        .order('risk_score', { ascending: false, nullsFirst: false })
        .limit(50),
    ])
    if (blacklist.error) return c.json({ error: 'db_error', detail: blacklist.error.message }, 500)
    if (sms.error) return c.json({ error: 'db_error', detail: sms.error.message }, 500)
    if (clients.error) return c.json({ error: 'db_error', detail: clients.error.message }, 500)
    return c.json({ blacklist: blacklist.data ?? [], sms: sms.data ?? [], clients: clients.data ?? [] })
  },
)

// ---- Risk: velocity offenders (sender_number aggregation over a window) ----
// Surfaces fraud-shaped behaviour like one number sending dozens of deposits
// with a very high decline rate (e.g. 01055953836: 96 txns / 91 declined).
extraRoutes.get(
  '/risk/velocity',
  requireAnyPerm(['risk', 'risk_audit', 'flagged', 'velocity', 'compliance'], 'can_view'),
  async (c) => {
    const minTxns = Math.min(Math.max(Number(c.req.query('min_txns')) || 20, 2), 500)
    const windowDays = Math.min(Math.max(Number(c.req.query('window_days')) || 30, 1), 365)
    const { data, error } = await db.rpc('panel_velocity_offenders', {
      p_min_txns: minTxns, p_window_days: windowDays, p_limit: 100,
    })
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    return c.json({ offenders: data ?? [], min_txns: minTxns, window_days: windowDays })
  },
)

// Add a sender_number to the blacklist straight from the velocity view.
extraRoutes.post(
  '/risk/blacklist',
  requireAnyPerm(['risk', 'risk_audit', 'flagged', 'velocity', 'compliance'], 'can_edit'),
  async (c) => {
    const body = await c.req.json().catch(() => null)
    const value = typeof body?.value === 'string' ? body.value.trim() : ''
    const type = typeof body?.type === 'string' && body.type.trim() ? body.type.trim().slice(0, 40) : 'phone'
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : null
    if (!value) return c.json({ error: 'value_required' }, 400)
    const actor = c.get('actor')
    const { data: existing } = await db.from('api_risk_blacklist').select('id').eq('value', value).maybeSingle()
    if (existing) return c.json({ error: 'already_blacklisted', id: existing.id }, 409)
    const { data, error } = await db.from('api_risk_blacklist')
      .insert({ type, value, reason: reason ?? `Added from velocity view by ${actor.username}` })
      .select('id, type, value, reason, created_at').single()
    if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
    await db.from('audit_log').insert({
      actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
      action: 'risk.blacklist_add', entity: 'api_risk_blacklist', entity_id: data.id, after: { type, value, reason },
    })
    return c.json({ entry: data }, 201)
  },
)

// ---- Automation: settings + rules + worker jobs + treasury ----
extraRoutes.get(
  '/automation',
  requireAnyPerm(
    ['telegram_bot', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team'],
    'can_view',
  ),
  async (c) => {
    const [settings, rules, jobs, balances, rates] = await Promise.all([
      db.from('automation_settings').select('*').limit(1).maybeSingle(),
      db
        .from('automation_rules_scoped')
        .select('id, scope_type, master_merchant, merchant, payment_method, provider, enabled, min_amount, max_amount, action_type, priority')
        .order('priority')
        .limit(100),
      db
        .from('browser_jobs')
        .select('id, tx_id, amount, target_status, provider, source, state, mission, attempts, last_error, operator_username, created_at, completed_at')
        .order('created_at', { ascending: false })
        .limit(15),
      db.from('binance_account_balances').select('account_id, total_balance, available_balance, usdt_value, measured_at').order('measured_at', { ascending: false }).limit(10),
      db.from('exchange_rates').select('currency_pair, rate, fetched_at').order('fetched_at', { ascending: false }).limit(10),
    ])
    if (rules.error) return c.json({ error: 'db_error', detail: rules.error.message }, 500)
    return c.json({
      settings: settings.data ?? null,
      rules: rules.data ?? [],
      jobs: jobs.data ?? [],
      balances: balances.data ?? [],
      rates: rates.data ?? [],
    })
  },
)

// ---- Audit log ----
extraRoutes.get('/audit', requireAnyPerm(['audit_log', 'audit-logs'], 'can_view'), async (c) => {
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  let query = db
    .from('audit_log')
    .select('id, actor_type, actor_name, action, entity, entity_id, before, after, ip, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (q) {
    const like = `%${q}%`
    query = query.or([`action.ilike.${like}`, `actor_name.ilike.${like}`, `entity_id.ilike.${like}`].join(','))
  }
  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0, limit, offset })
})

// ---- Admin: users + permission matrix + api keys + webhooks ----
extraRoutes.get(
  '/admin',
  requireAnyPerm(['users', 'permissions', 'api-keys', 'webhooks', 'developers', 'settings'], 'can_view'),
  async (c) => {
    const [users, perms, keys, hooks] = await Promise.all([
      db
        .from('panel_users')
        .select('id, username, display_name, role, active, last_login_at, failed_login_count, locked_until, created_at')
        .order('username'),
      db.from('role_page_permissions').select('role_key, page_key, can_view, can_edit, can_approve').order('page_key'),
      db
        .from('merchant_api_keys')
        .select('id, merchant_id, key_name, environment, is_active, request_count, secret_prefix, last_used_at, created_at')
        .order('created_at', { ascending: false })
        .limit(100),
      db.from('merchants').select('id, name, callback_url').not('callback_url', 'is', null),
    ])
    if (users.error) return c.json({ error: 'db_error', detail: users.error.message }, 500)
    return c.json({
      users: users.data ?? [],
      permissions: perms.data ?? [],
      apiKeys: keys.data ?? [],
      webhooks: hooks.data ?? [],
    })
  },
)

// ---- Reports: all-time or filterable date-range analytics ----
extraRoutes.get('/reports', requireAnyPerm(['reports', 'advanced_analysis'], 'can_view'), async (c) => {
  // Empty dates deliberately mean the complete live dataset.
  const from = c.req.query('from')?.trim() || null
  const to = c.req.query('to')?.trim() || null
  const merchant = c.req.query('merchant')?.trim()
  const master = c.req.query('master')?.trim()
  const excludeTest = c.req.query('excludeTest') === '1'

  let depQ = db
    .from('maven_transactions')
    .select('amount, status, merchant, master_merchant, payment_method, gateway, commission, fees, first_seen_at')
    .order('first_seen_at', { ascending: true, nullsFirst: false })
  if (from) depQ = depQ.gte('first_seen_at', `${from}T00:00:00Z`)
  if (to) depQ = depQ.lte('first_seen_at', `${to}T23:59:59Z`)
  if (merchant) depQ = depQ.eq('merchant', merchant)
  if (master) depQ = depQ.ilike('master_merchant', `%${master}%`)
  if (excludeTest) depQ = depQ.not('merchant', 'is', null).not('merchant', 'ilike', '%test%')

  let payQ = db
    .from('maven_payout_transactions')
    .select('amount, status, merchant, commission, first_seen_at')
    .order('first_seen_at', { ascending: true, nullsFirst: false })
  if (from) payQ = payQ.gte('first_seen_at', `${from}T00:00:00Z`)
  if (to) payQ = payQ.lte('first_seen_at', `${to}T23:59:59Z`)
  if (merchant) payQ = payQ.eq('merchant', merchant)
  if (excludeTest) payQ = payQ.not('merchant', 'is', null).not('merchant', 'ilike', '%test%')

  const fetchAll = async (query: any) => {
    const rows: any[] = []
    const pageSize = 1_000
    const maxRows = 50_000
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const { data, error } = await query.range(offset, offset + pageSize - 1)
      if (error) return { data: rows, error }
      rows.push(...(data ?? []))
      if ((data ?? []).length < pageSize) break
    }
    return { data: rows, error: null }
  }

  const [dep, pay] = await Promise.all([fetchAll(depQ), fetchAll(payQ)])
  if (dep.error) return c.json({ error: 'db_error', detail: dep.error.message }, 500)
  if (pay.error) return c.json({ error: 'db_error', detail: pay.error.message }, 500)

  const approved = (status: string) => status === 'PAID' || status === 'APPROVED'
  const totals = { depCount: 0, depVolume: 0, declined: 0, commission: 0, fees: 0, payCount: 0, payVolume: 0 }
  interface Day { date: string; depCount: number; depVolume: number; declined: number; commission: number; payVolume: number }
  interface Agg { key: string; master: string | null; count: number; volume: number; commission: number; fees: number }
  const daily = new Map<string, Day>()
  const byMerchant = new Map<string, Agg>()
  const byMethod = new Map<string, Agg>()
  const getDay = (date: string) => {
    if (!daily.has(date)) daily.set(date, { date, depCount: 0, depVolume: 0, declined: 0, commission: 0, payVolume: 0 })
    return daily.get(date)!
  }
  const bump = (map: Map<string, Agg>, key: string, masterValue: string | null, amount: number, commission: number, fees: number) => {
    if (!map.has(key)) map.set(key, { key, master: masterValue, count: 0, volume: 0, commission: 0, fees: 0 })
    const bucket = map.get(key)!
    bucket.count += 1
    bucket.volume += amount
    bucket.commission += commission
    bucket.fees += fees
  }

  for (const row of dep.data) {
    const date = row.first_seen_at?.slice(0, 10)
    if (!date) continue
    const day = getDay(date)
    if (approved(row.status)) {
      const amount = Number(row.amount ?? 0)
      const commission = Number(row.commission ?? 0)
      const fees = Number(row.fees ?? 0)
      totals.depCount += 1
      totals.depVolume += amount
      totals.commission += commission
      totals.fees += fees
      day.depCount += 1
      day.depVolume += amount
      day.commission += commission
      bump(byMerchant, row.merchant ?? '—', row.master_merchant, amount, commission, fees)
      bump(byMethod, `${row.payment_method ?? row.gateway ?? '—'}||${row.master_merchant ?? '—'}`, row.master_merchant, amount, commission, fees)
    } else if (row.status === 'DECLINED') {
      totals.declined += 1
      day.declined += 1
    }
  }

  for (const row of pay.data) {
    const date = row.first_seen_at?.slice(0, 10)
    if (!date || row.status !== 'APPROVED') continue
    const amount = Number(row.amount ?? 0)
    totals.payCount += 1
    totals.payVolume += amount
    getDay(date).payVolume += amount
  }

  return c.json({
    from,
    to,
    totals,
    daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)),
    byMerchant: [...byMerchant.values()].sort((a, b) => b.volume - a.volume),
    byMethod: [...byMethod.values()].sort((a, b) => b.volume - a.volume),
  })
})

// ---- Notifications (bell) — available to every authed user ----
extraRoutes.get('/notifications', async (c) => {
  const twoDays = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const countOf = async (apply: (q: any) => any) => {
    const { count } = await apply(db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }))
    return count ?? 0
  }
  const [pendingDeposits, pendingPayouts, smsReview, devices, latestPending] = await Promise.all([
    countOf((q: any) => q.eq('status', 'PENDING')),
    db
      .from('maven_payout_transactions')
      .select('maven_id', { count: 'exact', head: true })
      .eq('status', 'PENDING')
      .then(({ count }) => count ?? 0),
    db
      .from('inbound_sms')
      .select('id', { count: 'exact', head: true })
      .eq('review_required', true)
      .eq('matched', false)
      .gte('received_at', twoDays)
      .then(({ count }) => count ?? 0),
    db.from('device_status').select('device, online').then(({ data }) => data ?? []),
    db
      .from('maven_transactions')
      .select('tx_id, ontarget_ref, amount, currency, sender_name, merchant')
      .eq('status', 'PENDING')
      .order('ontarget_ref', { ascending: false, nullsFirst: false })
      .limit(5)
      .then(({ data }) => data ?? []),
  ])
  const offlineDevices = devices.filter((d) => !d.online).map((d) => d.device)
  return c.json({
    pendingDeposits,
    pendingPayouts,
    smsReview,
    offlineDevices,
    latestPending,
    total: pendingDeposits + pendingPayouts + (smsReview > 0 ? 1 : 0) + (offlineDevices.length > 0 ? 1 : 0),
  })
})

// ---- Payment methods: live channel configuration plus 30-day transaction health ----
extraRoutes.get(
  '/payment-methods',
  requireAnyPerm(['wallets', 'payment_methods'], 'can_view'),
  async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const [channels, transactions, wallets] = await Promise.all([
      db
        .from('local_deposit_channels')
        .select('id, channel_type, country_code, currency_code, display_name, active')
        .order('display_name'),
      db
        .from('maven_transactions')
        .select('payment_method, gateway, status, amount')
        .gte('first_seen_at', since)
        .order('first_seen_at', { ascending: false, nullsFirst: false })
        .limit(10_000),
      db
        .from('wallet_device_map')
        .select('provider, device, sim_slot')
        .order('provider'),
    ])
    if (channels.error) return new Response(JSON.stringify({ error: 'db_error', detail: channels.error.message }), { status: 500 })
    if (transactions.error) return new Response(JSON.stringify({ error: 'db_error', detail: transactions.error.message }), { status: 500 })
    if (wallets.error) return new Response(JSON.stringify({ error: 'db_error', detail: wallets.error.message }), { status: 500 })

    const byMethod = new Map<string, { key: string; attempts: number; approved: number; volume: number }>()
    for (const row of transactions.data ?? []) {
      const key = row.payment_method ?? row.gateway ?? 'Unspecified'
      if (!byMethod.has(key)) byMethod.set(key, { key, attempts: 0, approved: 0, volume: 0 })
      const bucket = byMethod.get(key)!
      bucket.attempts += 1
      if (row.status === 'PAID' || row.status === 'APPROVED') {
        bucket.approved += 1
        bucket.volume += Number(row.amount ?? 0)
      }
    }
    const walletCount = new Map<string, number>()
    for (const row of wallets.data ?? []) {
      const key = row.provider ?? 'Unspecified'
      walletCount.set(key, (walletCount.get(key) ?? 0) + 1)
    }

    return Response.json({
      channels: channels.data ?? [],
      methods: [...byMethod.values()].sort((a, b) => b.volume - a.volume),
      walletCount: Object.fromEntries(walletCount),
      since,
    })
  },
)

extraRoutes.patch(
  '/payment-methods/:id',
  requireAnyPerm(['wallets', 'payment_methods'], 'can_edit'),
  async (c) => {
    const body = await c.req.json<{ active?: boolean }>().catch(() => null)
    if (typeof body?.active !== 'boolean') return c.json({ error: 'invalid_active' }, 400)
    const { data, error } = await db
      .from('local_deposit_channels')
      .update({ active: body.active })
      .eq('id', c.req.param('id'))
      .select('id, channel_type, country_code, currency_code, display_name, active')
      .maybeSingle()
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    if (!data) return c.json({ error: 'channel_not_found' }, 404)
    return c.json({ channel: data })
  },
)

// ---- Known recipients: outgoing payout recipients, aggregated from live history ----
const recipientKey = (value: string) => {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 6 ? digits : value.trim().toLowerCase()
}

const loadRecipientPayouts = async (from: string | null, to: string | null) => {
  let query = db
    .from('maven_payout_transactions')
    .select('maven_id, ontarget_ref, amount, status, pay_by, merchant, account_name, mobile_no, approved_by, first_seen_at')
    .order('first_seen_at', { ascending: false, nullsFirst: false })
  if (from) query = query.gte('first_seen_at', `${from}T00:00:00Z`)
  if (to) query = query.lte('first_seen_at', `${to}T23:59:59Z`)

  const rows: any[] = []
  for (let offset = 0; offset < 50_000; offset += 1_000) {
    const { data, error } = await query.range(offset, offset + 999)
    if (error) return { rows, error }
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1_000) break
  }
  return { rows, error: null }
}

extraRoutes.get(
  '/known-recipients',
  requireAnyPerm(['wallets', 'payouts'], 'can_view'),
  async (c) => {
    const from = c.req.query('from')?.trim() || null
    const to = c.req.query('to')?.trim() || null
    const q = c.req.query('q')?.trim().toLowerCase() || ''
    const result = await loadRecipientPayouts(from, to)
    if (result.error) return c.json({ error: 'db_error', detail: result.error.message }, 500)

    const grouped = new Map<string, {
      recipient: string
      accountName: string | null
      count: number
      approvedCount: number
      total: number
      lastAt: string | null
      methods: Set<string>
      merchants: Set<string>
    }>()
    for (const row of result.rows) {
      const recipient = String(row.mobile_no ?? row.account_name ?? '').trim()
      if (!recipient) continue
      const key = recipientKey(recipient)
      if (!grouped.has(key)) grouped.set(key, {
        recipient,
        accountName: row.account_name ?? null,
        count: 0,
        approvedCount: 0,
        total: 0,
        lastAt: row.first_seen_at ?? null,
        methods: new Set(),
        merchants: new Set(),
      })
      const bucket = grouped.get(key)!
      bucket.count += 1
      if (row.status === 'APPROVED' || row.status === 'PAID') {
        bucket.approvedCount += 1
        bucket.total += Number(row.amount ?? 0)
      }
      if (!bucket.lastAt || String(row.first_seen_at ?? '') > bucket.lastAt) bucket.lastAt = row.first_seen_at ?? bucket.lastAt
      if (row.pay_by) bucket.methods.add(row.pay_by)
      if (row.merchant) bucket.merchants.add(row.merchant)
    }

    const recipients = [...grouped.entries()]
      .map(([key, value]) => ({ ...value, key, methods: [...value.methods], merchants: [...value.merchants] }))
      .filter((row) => !q || [row.recipient, row.accountName, ...row.methods, ...row.merchants].filter(Boolean).join(' ').toLowerCase().includes(q))
      .sort((a, b) => b.total - a.total || b.count - a.count)
      .slice(0, 1_000)
    return c.json({ from, to, recipients })
  },
)

extraRoutes.get(
  '/known-recipients/:recipient',
  requireAnyPerm(['wallets', 'payouts'], 'can_view'),
  async (c) => {
    const target = recipientKey(decodeURIComponent(c.req.param('recipient')))
    const result = await loadRecipientPayouts(null, null)
    if (result.error) return c.json({ error: 'db_error', detail: result.error.message }, 500)
    const events = result.rows
      .filter((row) => recipientKey(String(row.mobile_no ?? row.account_name ?? '')) === target)
      .slice(0, 250)
    return c.json({ events })
  },
)

// ---- Treasury & wallets hub: live operating summary across wallets, messages and flow ----
extraRoutes.get(
  '/treasury-hub',
  requireAnyPerm(['wallets', 'payouts', 'sms_live', 'treasury'], 'can_view'),
  async (c) => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const [wallets, devices, deposits, payouts, sms] = await Promise.all([
      db.from('wallet_device_map').select('to_account_number, provider, device, sim_slot, payment_type, daily_limit, merchant, updated_at').order('provider').limit(500),
      db.from('device_status').select('device, sim_slot, online, battery, balance, last_seen_at').order('device').limit(500),
      db.from('maven_transactions').select('tx_id, ontarget_ref, amount, status, sender_name, sender_number, to_account_number, payment_method, approved_by, first_seen_at').gte('first_seen_at', since).order('first_seen_at', { ascending: false, nullsFirst: false }).limit(500),
      db.from('maven_payout_transactions').select('maven_id, ontarget_ref, amount, status, pay_by, merchant, account_name, mobile_no, approved_by, first_seen_at').gte('first_seen_at', since).order('first_seen_at', { ascending: false, nullsFirst: false }).limit(500),
      db.from('inbound_sms').select('id, amount, sender_name, sender_number, receiver_number, device_name, sim_slot, sms_category, matched, received_at').order('received_at', { ascending: false, nullsFirst: false }).limit(250),
    ])
    for (const result of [wallets, devices, deposits, payouts, sms]) {
      if (result.error) return c.json({ error: 'db_error', detail: result.error.message }, 500)
    }
    const depositRows = deposits.data ?? []
    const payoutRows = payouts.data ?? []
    const approvedDeposit = depositRows.filter((row) => row.status === 'PAID' || row.status === 'APPROVED').reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
    const approvedPayout = payoutRows.filter((row) => row.status === 'APPROVED' || row.status === 'PAID').reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
    return c.json({
      since,
      totals: { approvedDeposit, approvedPayout, net: approvedDeposit - approvedPayout },
      wallets: wallets.data ?? [],
      devices: devices.data ?? [],
      deposits: depositRows,
      payouts: payoutRows,
      sms: sms.data ?? [],
    })
  },
)

// ---- Executive dashboard: management-level, live operating indicators ----
extraRoutes.get(
  '/executive-dashboard',
  requireAnyPerm(['dashboard', 'reports', 'advanced_analysis', 'treasury', 'wallets'], 'can_view'),
  async (c) => {
    const now = Date.now()
    const day = new Date(now - 24 * 86_400_000).toISOString()
    const week = new Date(now - 7 * 86_400_000).toISOString()
    const month = new Date(now - 30 * 86_400_000).toISOString()
    const [deposits, payouts, pendingDeposits, pendingPayouts, devices, sms] = await Promise.all([
      db.from('maven_transactions').select('amount, status, merchant, first_seen_at').gte('first_seen_at', month).order('first_seen_at', { ascending: true, nullsFirst: false }).limit(10_000),
      db.from('maven_payout_transactions').select('amount, status, merchant, first_seen_at').gte('first_seen_at', month).order('first_seen_at', { ascending: true, nullsFirst: false }).limit(10_000),
      db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
      db.from('maven_payout_transactions').select('maven_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
      db.from('device_status').select('device, sim_slot, online, battery, last_seen_at').order('device').limit(500),
      db.from('inbound_sms').select('id, matched, sms_category, received_at').gte('received_at', day).order('received_at', { ascending: false, nullsFirst: false }).limit(1_000),
    ])
    for (const result of [deposits, payouts, pendingDeposits, pendingPayouts, devices, sms]) {
      if (result.error) return c.json({ error: 'db_error', detail: result.error.message }, 500)
    }

    const isApproved = (status: string | null) => status === 'PAID' || status === 'APPROVED'
    const windowSummary = (since: string) => {
      const dep = (deposits.data ?? []).filter((row) => String(row.first_seen_at ?? '') >= since)
      const pay = (payouts.data ?? []).filter((row) => String(row.first_seen_at ?? '') >= since)
      const approvedDep = dep.filter((row) => isApproved(row.status))
      const approvedPay = pay.filter((row) => isApproved(row.status))
      return {
        depositCount: approvedDep.length,
        depositVolume: approvedDep.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
        payoutCount: approvedPay.length,
        payoutVolume: approvedPay.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
        declined: dep.filter((row) => row.status === 'DECLINED').length,
        attempts: dep.length,
      }
    }
    const monthly = windowSummary(month)
    const byMerchant = new Map<string, { merchant: string; volume: number; count: number }>()
    for (const row of deposits.data ?? []) {
      if (!isApproved(row.status)) continue
      const merchant = row.merchant ?? 'Unassigned'
      const bucket = byMerchant.get(merchant) ?? { merchant, volume: 0, count: 0 }
      bucket.volume += Number(row.amount ?? 0)
      bucket.count += 1
      byMerchant.set(merchant, bucket)
    }
    const daily = new Map<string, { date: string; incoming: number; outgoing: number }>()
    const dailyRow = (date: string) => {
      if (!daily.has(date)) daily.set(date, { date, incoming: 0, outgoing: 0 })
      return daily.get(date)!
    }
    for (const row of deposits.data ?? []) {
      if (isApproved(row.status) && row.first_seen_at) dailyRow(row.first_seen_at.slice(0, 10)).incoming += Number(row.amount ?? 0)
    }
    for (const row of payouts.data ?? []) {
      if (isApproved(row.status) && row.first_seen_at) dailyRow(row.first_seen_at.slice(0, 10)).outgoing += Number(row.amount ?? 0)
    }
    const deviceRows = devices.data ?? []
    const liveSms = sms.data ?? []
    return c.json({
      generatedAt: new Date().toISOString(),
      windows: { day: windowSummary(day), week: windowSummary(week), month: monthly },
      queues: { pendingDeposits: pendingDeposits.count ?? 0, pendingPayouts: pendingPayouts.count ?? 0, smsReview: liveSms.filter((row) => !row.matched && (row.sms_category === 'deposit' || row.sms_category === 'withdrawal')).length },
      devices: { total: deviceRows.length, online: deviceRows.filter((row) => row.online).length, rows: deviceRows.slice(0, 20) },
      topMerchants: [...byMerchant.values()].sort((a, b) => b.volume - a.volume).slice(0, 8),
      daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30),
    })
  },
)
