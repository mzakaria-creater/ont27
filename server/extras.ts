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

// ---- Reports: daily volumes ----
extraRoutes.get('/reports', requireAnyPerm(['reports', 'advanced_analysis'], 'can_view'), async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days')) || 14, 1), 60)
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const [dep, pay] = await Promise.all([
    db.from('maven_transactions').select('amount, status, master_merchant, first_seen_at').gte('first_seen_at', since).limit(10_000),
    db.from('maven_payout_transactions').select('amount, status, first_seen_at').gte('first_seen_at', since).limit(10_000),
  ])
  if (dep.error) return c.json({ error: 'db_error', detail: dep.error.message }, 500)
  if (pay.error) return c.json({ error: 'db_error', detail: pay.error.message }, 500)

  interface Day {
    date: string
    depCount: number
    depVolume: number
    declined: number
    payVolume: number
  }
  const daysMap = new Map<string, Day>()
  const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
  for (const r of dep.data ?? []) {
    const d = dayOf(r.first_seen_at)
    if (!d) continue
    if (!daysMap.has(d)) daysMap.set(d, { date: d, depCount: 0, depVolume: 0, declined: 0, payVolume: 0 })
    const bucket = daysMap.get(d)!
    if (r.status === 'PAID' || r.status === 'APPROVED') {
      bucket.depCount += 1
      bucket.depVolume += Number(r.amount ?? 0)
    } else if (r.status === 'DECLINED') bucket.declined += 1
  }
  for (const r of pay.data ?? []) {
    const d = dayOf(r.first_seen_at)
    if (!d || r.status !== 'APPROVED') continue
    if (!daysMap.has(d)) daysMap.set(d, { date: d, depCount: 0, depVolume: 0, declined: 0, payVolume: 0 })
    daysMap.get(d)!.payVolume += Number(r.amount ?? 0)
  }
  const rows = [...daysMap.values()].sort((a, b) => b.date.localeCompare(a.date))
  return c.json({ days, rows })
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
