import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth, requirePerm, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'
import { MAX_PAGE } from './paging.js'

// The remaining §5 module pages, one route each. Sensitive columns
// (api_key, secret_hash, password_hash, raw_profile, tokens) are NEVER selected.

export const extraRoutes = new Hono<AuthEnv>()

extraRoutes.use('*', requireAuth)

const DEPOSIT_COLS =
  'tx_id, ontarget_ref, merchant_tx_reference, status, amount, currency, sender_name, sender_number, receiving_wallet, to_account_number, payment_method, gateway, merchant, master_merchant, approved_by, proof_image_url, first_seen_at, created_utc, maven_raw_row'
const PAYOUT_COLS =
  'maven_id, ontarget_ref, status, amount, pay_by, merchant, account_name, mobile_no, agent_name, approved_by, image_url, first_seen_at, created_utc'

function withSenderAccount<T extends Record<string, unknown>>(row: T): Omit<T, 'maven_raw_row'> & { sender_account_number: string | null; sender_account_name: string | null; user_email: string | null } {
  const raw = row.maven_raw_row && typeof row.maven_raw_row === 'object' && !Array.isArray(row.maven_raw_row)
    ? row.maven_raw_row as Record<string, unknown>
    : null
  const rawValue = (wanted: string[]) => raw
    ? Object.entries(raw).find(([key]) => wanted.includes(key.replace(/[^a-z0-9]/gi, '').toLowerCase()))?.[1]
    : null
  const account = rawValue(['accountnumber', 'senderaccountnumber', 'bankaccountnumber'])
  const accountName = rawValue(['accountname', 'senderaccountname', 'bankaccountname'])
  const email = rawValue(['emailaddress', 'useremail', 'email'])
  const { maven_raw_row: _raw, ...safe } = row
  const fallback = typeof row.sender_number === 'string' ? row.sender_number : null
  return {
    ...safe,
    sender_account_number: account == null ? fallback : String(account).trim() || fallback,
    sender_account_name: accountName == null ? null : String(accountName).trim() || null,
    user_email: email == null ? null : String(email).trim() || null,
  }
}

// ---- Unified transactions (deposits + payouts) ----
extraRoutes.get(
  '/transactions',
  requireAnyPerm(['transactions', 'all_transactions', 'refunds', 'reversals'], 'can_view'),
  async (c) => {
    const type = c.req.query('type') // deposit | payout | ''
    const status = c.req.query('status')?.toUpperCase()
    const q = c.req.query('q')?.trim()
    const from = c.req.query('from')?.trim()
    const to = c.req.query('to')?.trim()
    const merchant = c.req.query('merchant')?.trim()
    const method = c.req.query('method')?.trim()
    const currency = c.req.query('currency')?.trim().toUpperCase()
    const minAmount = Number(c.req.query('min_amount'))
    const maxAmount = Number(c.req.query('max_amount'))
    const limit = Math.min(Number(c.req.query('limit')) || 25, MAX_PAGE)
    const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
    const fetchTo = offset + limit

    const depQuery = () => {
      let query = db
        .from('maven_transactions')
        .select(DEPOSIT_COLS, { count: 'exact' })
        .order('created_utc', { ascending: false, nullsFirst: false })
        .range(0, fetchTo - 1)
      if (status) query = query.eq('status', status)
      if (from) query = query.gte('first_seen_at', `${from}T00:00:00Z`)
      if (to) query = query.lte('first_seen_at', `${to}T23:59:59.999Z`)
      if (merchant) query = query.ilike('merchant', `%${merchant.replaceAll(',', ' ')}%`)
      if (method) query = query.ilike('payment_method', `%${method.replaceAll(',', ' ')}%`)
      if (currency) query = query.eq('currency', currency)
      if (Number.isFinite(minAmount)) query = query.gte('amount', minAmount)
      if (Number.isFinite(maxAmount)) query = query.lte('amount', maxAmount)
      if (q) {
        const like = `%${q.replaceAll(',', ' ')}%`
        const ors = [`ontarget_ref.ilike.${like}`, `merchant_tx_reference.ilike.${like}`, `sender_number.ilike.${like}`, `sender_name.ilike.${like}`, `maven_raw_row->>AccountNumber.ilike.${like}`, `maven_raw_row->>PhoneNo.ilike.${like}`, `maven_raw_row->>UserName.ilike.${like}`, `receiving_wallet.ilike.${like}`, `to_account_number.ilike.${like}`, `merchant.ilike.${like}`]
        if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
        if (/^\d+(\.\d{1,2})?$/.test(q)) ors.push(`amount.eq.${q}`)
        query = query.or(ors.join(','))
      }
      return query
    }
    const payQuery = () => {
      let query = db
        .from('maven_payout_transactions')
        .select(PAYOUT_COLS, { count: 'exact' })
        .order('created_utc', { ascending: false, nullsFirst: false })
        .range(0, fetchTo - 1)
      if (status) query = query.eq('status', status)
      if (from) query = query.gte('first_seen_at', `${from}T00:00:00Z`)
      if (to) query = query.lte('first_seen_at', `${to}T23:59:59.999Z`)
      if (merchant) query = query.ilike('merchant', `%${merchant.replaceAll(',', ' ')}%`)
      if (method) query = query.ilike('pay_by', `%${method.replaceAll(',', ' ')}%`)
      if (currency && currency !== 'EGP') query = query.eq('maven_id', -1)
      if (Number.isFinite(minAmount)) query = query.gte('amount', minAmount)
      if (Number.isFinite(maxAmount)) query = query.lte('amount', maxAmount)
      if (q) {
        const like = `%${q.replaceAll(',', ' ')}%`
        const ors = [`ontarget_ref.ilike.${like}`, `mobile_no.ilike.${like}`, `account_name.ilike.${like}`, `merchant.ilike.${like}`]
        if (/^\d+$/.test(q)) ors.push(`maven_id.eq.${q}`)
        if (/^\d+(\.\d{1,2})?$/.test(q)) ors.push(`amount.eq.${q}`)
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
      ...((dep.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({ ...withSenderAccount(r), kind: 'deposit' })),
      ...((pay.data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({ ...r, kind: 'payout' })),
    ] as Record<string, unknown>[]).sort((a, b) =>
      new Date(String(b.created_utc ?? b.first_seen_at ?? 0)).getTime() - new Date(String(a.created_utc ?? a.first_seen_at ?? 0)).getTime(),
    )

    const pageRows = rows.slice(offset, offset + limit)
    const depositPhones = [...new Set(pageRows.filter((row) => row.kind === 'deposit').map((row) => String(row.sender_number ?? '').trim()).filter(Boolean))]
    const payoutPhones = [...new Set(pageRows.filter((row) => row.kind === 'payout').map((row) => String(row.mobile_no ?? '').trim()).filter(Boolean))]
    const [depositHistory, payoutHistory] = await Promise.all([
      depositPhones.length ? db.from('maven_transactions').select('sender_number').in('sender_number', depositPhones).limit(10_000) : Promise.resolve({ data: [], error: null }),
      payoutPhones.length ? db.from('maven_payout_transactions').select('mobile_no').in('mobile_no', payoutPhones).limit(10_000) : Promise.resolve({ data: [], error: null }),
    ])
    const clientCounts = new Map<string, number>()
    for (const item of depositHistory.data ?? []) { const key = String(item.sender_number ?? '').trim(); if (key) clientCounts.set(key, (clientCounts.get(key) ?? 0) + 1) }
    for (const item of payoutHistory.data ?? []) { const key = String(item.mobile_no ?? '').trim(); if (key) clientCounts.set(key, (clientCounts.get(key) ?? 0) + 1) }

    return c.json({
      rows: pageRows.map((row) => {
        const clientKey = String(row.kind === 'deposit' ? row.sender_number ?? '' : row.mobile_no ?? '').trim()
        return { ...row, client_transaction_count: clientKey ? clientCounts.get(clientKey) ?? 1 : 1 }
      }),
      total: (dep.count ?? 0) + (pay.count ?? 0),
      limit,
      offset,
    })
  },
)

// Per-status transaction counts for the summary strip (respects type filter).
extraRoutes.get(
  '/transactions/status-counts',
  requireAnyPerm(['transactions', 'all_transactions', 'refunds', 'reversals'], 'can_view'),
  async (c) => {
    const type = c.req.query('type') === 'payout' ? 'payout' : c.req.query('type') === 'deposit' ? 'deposit' : ''
    const { data, error } = await db.rpc('panel_tx_status_counts', { p_type: type })
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    return c.json({ counts: data ?? [] })
  },
)

// ---- Approvals queue (everything PENDING) ----
// Reviewer-facing evidence columns on top of DEPOSIT_COLS: the proof image and
// the receiving wallet are what an operator actually checks before deciding, so
// the queue shouldn't force a round-trip to the detail page for them.
// Note: sender_number is the same value the provider sends as raw->>'PhoneNo'
// (verified: 0 of 801 recent NGPay rows differ), so there is only ONE customer
// phone here — it is deliberately not rendered twice under two labels.
const APPROVAL_DEPOSIT_COLS = `${DEPOSIT_COLS}, to_account_name, to_bank`

extraRoutes.get(
  '/approvals',
  requireAnyPerm(['approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me'], 'can_view'),
  async (c) => {
    const [dep, pay] = await Promise.all([
      db
        .from('maven_transactions')
        .select(APPROVAL_DEPOSIT_COLS)
        .eq('status', 'PENDING')
        .order('first_seen_at', { ascending: false, nullsFirst: false })
        .limit(100),
      db
        .from('maven_payout_transactions')
        .select(PAYOUT_COLS)
        .eq('status', 'PENDING')
        .order('first_seen_at', { ascending: false, nullsFirst: false })
        .limit(100),
    ])
    if (dep.error) return c.json({ error: 'db_error', detail: dep.error.message }, 500)
    if (pay.error) return c.json({ error: 'db_error', detail: pay.error.message }, 500)
    const deposits = (dep.data ?? []).map((row) => withSenderAccount(row))
    const txIds = deposits.map((row) => row.tx_id)
    // Classify from approved history, never from the placeholder sender name.
    // A customer with at least one earlier approved deposit is a retention
    // deposit; otherwise the pending row is their first deposit.
    const normalizePhone = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
    const senderPhoneValues = [...new Set(deposits.map((row) => String(row.sender_number ?? '').trim()).filter(Boolean))]
    const approvedHistory = new Map<string, number>()
    if (senderPhoneValues.length) {
      const { data: history } = await db.from('maven_transactions')
        .select('sender_number, status, first_seen_at')
        .in('status', ['PAID', 'APPROVED'])
        .in('sender_number', senderPhoneValues)
        .limit(10_000)
      for (const row of history ?? []) {
        const key = normalizePhone(row.sender_number)
        if (key) approvedHistory.set(key, (approvedHistory.get(key) ?? 0) + 1)
      }
    }
    const smsByTx = new Map<number, Record<string, unknown>>()
    const reasonByTx = new Map<number, Record<string, unknown>>()
    if (txIds.length) {
      const { data: smsRows } = await db.from('inbound_sms')
        .select('id, consumed_by_tx_id, received_at, sender_name, sender_number, receiver_number, amount, sms_first_line, match_status, matched')
        .in('consumed_by_tx_id', txIds).order('received_at', { ascending: false })
      for (const sms of smsRows ?? []) if (sms.consumed_by_tx_id != null && !smsByTx.has(Number(sms.consumed_by_tx_id))) smsByTx.set(Number(sms.consumed_by_tx_id), sms)
      const { data: localReasons } = await db.from('deposit_decision_log')
        .select('tx_id, decision, reason, actor_name, created_at').in('tx_id', txIds).order('created_at', { ascending: false })
      for (const row of localReasons ?? []) if (!reasonByTx.has(Number(row.tx_id))) reasonByTx.set(Number(row.tx_id), row)
      const source = oldDb()
      if (source) {
        const { data: reviews } = await source.from('review_queue')
          .select('tx_id, decision, decision_reason, match_score, match_reasons, matched_sms_id, updated_at')
          .in('tx_id', txIds).order('updated_at', { ascending: false })
        for (const row of reviews ?? []) if (!reasonByTx.has(Number(row.tx_id))) reasonByTx.set(Number(row.tx_id), row)
      }
    }
    return c.json({ deposits: deposits.map((row) => {
      const previousApproved = approvedHistory.get(normalizePhone(row.sender_number)) ?? 0
      return {
        ...row,
        deposit_kind: previousApproved > 0 ? 'retention_deposit' : 'first_deposit',
        previous_approved_deposits: previousApproved,
        linked_sms: smsByTx.get(row.tx_id) ?? null,
        decision_context: reasonByTx.get(row.tx_id) ?? null,
      }
    }), payouts: pay.data ?? [] })
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

// ---- Wallet SMS report — per-wallet aggregate (idea from the old
// wallet-sms-report): SMS count/amount, deposits, withdrawals, unconfirmed,
// and current balance for each receiving wallet, over a window. ----
extraRoutes.get('/wallet-report', requireAnyPerm(['sms_live', 'wallets'], 'can_view'), async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365)
  const from = c.req.query('from')?.trim() || null
  const to = c.req.query('to')?.trim() || null
  const { data, error } = from || to
    ? await db.rpc('panel_wallet_sms_report_range', { p_from: from, p_to: to })
    : await db.rpc('panel_wallet_sms_report', { p_days: days })
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], days, from, to })
})

// Per-wallet detail: recent SMS for the wallet + transactions that landed on
// it, shown inline in the wallet-report drawer.
extraRoutes.get('/wallet-report/:wallet', requireAnyPerm(['sms_live', 'wallets'], 'can_view'), async (c) => {
  const wallet = c.req.param('wallet')
  if (!/^\d{6,}$/.test(wallet)) return c.json({ error: 'bad_wallet' }, 400)
  const [sms, txns] = await Promise.all([
    db.from('inbound_sms')
      .select('id, sms_first_line, message, amount, sms_category, matched, match_status, balance_after, device_name, received_at')
      .eq('receiver_number', wallet)
      .order('received_at', { ascending: false })
      .limit(40),
    db.from('maven_transactions')
      .select('ontarget_ref, status, amount, sender_name, master_merchant, first_seen_at')
      .or(`receiving_wallet.eq.${wallet},to_account_number.eq.${wallet}`)
      .order('first_seen_at', { ascending: false })
      .limit(40),
  ])
  if (sms.error) return c.json({ error: 'db_error', detail: sms.error.message }, 500)
  return c.json({ wallet, sms: sms.data ?? [], transactions: txns.data ?? [] })
})

// ---- CRM clients ----
extraRoutes.get('/crm', requirePerm('client_crm', 'can_view'), async (c) => {
  const q = c.req.query('q')?.trim()
  const segment = c.req.query('segment')?.trim()
  const sort = c.req.query('sort')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, MAX_PAGE)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  let query = db
    .from('crm_clients')
    .select(
      'id, client_name, phone_no, normalized_phone, merchant_name, first_transaction_at, last_transaction_at, total_deposit, approved_deposit, total_transactions, approved_transactions, declined_transactions, approval_rate, risk_score, is_vip, is_repeat_client, needs_review',
      { count: 'exact' },
    )
    .range(offset, offset + limit - 1)
  if (segment === 'vip') query = query.eq('is_vip', true)
  else if (segment === 'repeat') query = query.eq('is_repeat_client', true)
  else if (segment === 'review') query = query.eq('needs_review', true)
  else if (segment === 'risk') query = query.gt('risk_score', 0)
  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    query = query.or([`client_name.ilike.${like}`, `phone_no.ilike.${like}`, `normalized_phone.ilike.${like}`, `merchant_name.ilike.${like}`].join(','))
  }
  if (sort === 'volume') query = query.order('approved_deposit', { ascending: false, nullsFirst: false })
  else if (sort === 'risk') query = query.order('risk_score', { ascending: false, nullsFirst: false })
  else query = query.order('last_transaction_at', { ascending: false, nullsFirst: false })
  const [{ data, count, error }, summaryRows] = await Promise.all([
    query,
    db.from('crm_clients').select('approved_deposit, total_transactions, is_vip, is_repeat_client, needs_review, risk_score').limit(5000),
  ])
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (summaryRows.error) return c.json({ error: 'db_error', detail: summaryRows.error.message }, 500)
  const all = summaryRows.data ?? []
  return c.json({ rows: data ?? [], total: count ?? 0, limit, offset, summary: {
    clients: all.length,
    approvedVolume: all.reduce((sum, row) => sum + Number(row.approved_deposit ?? 0), 0),
    transactions: all.reduce((sum, row) => sum + Number(row.total_transactions ?? 0), 0),
    vip: all.filter((row) => row.is_vip).length,
    repeat: all.filter((row) => row.is_repeat_client).length,
    review: all.filter((row) => row.needs_review).length,
    risk: all.filter((row) => Number(row.risk_score ?? 0) > 0).length,
  } })
})

// Full client profile + their transactions (matched by sender_number against
// the client's phone). sms_names surfaces the different sender names seen for
// this number — the signal behind the name-mismatch investigations.
extraRoutes.get('/crm/:id', requirePerm('client_crm', 'can_view'), async (c) => {
  const { data: client, error } = await db
    .from('crm_clients')
    .select('id, client_name, phone_no, email_address, normalized_phone, merchant_name, first_transaction_at, last_transaction_at, total_deposit, approved_deposit, total_transactions, approved_transactions, declined_transactions, pending_transactions, approval_rate, risk_score, is_vip, is_repeat_client, needs_review, sms_names')
    .eq('id', c.req.param('id'))
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!client) return c.json({ error: 'not_found' }, 404)

  const phones = [client.phone_no, client.normalized_phone].filter(Boolean) as string[]
  let txns: unknown[] = []
  if (phones.length) {
    const { data: rows } = await db
      .from('maven_transactions')
      .select('ontarget_ref, status, amount, sender_name, sender_number, payment_method, master_merchant, first_seen_at')
      .in('sender_number', phones)
      .order('first_seen_at', { ascending: false })
      .limit(50)
    txns = rows ?? []
  }
  return c.json({ client, transactions: txns })
})

// ---- CRM: the whole customer, keyed on their phone number ----
//
// Separate from /crm/:id, which keys on a crm_clients row and matches
// transactions with `.in('sender_number', [phone_no, normalized_phone])` — an
// exact string comparison that misses every row stored in another shape
// (201…, +201…). This one normalises to the last 10 digits, the form the rest
// of the system already compares on, and works for a customer who has no CRM
// row at all — which is exactly when someone needs to look them up.
extraRoutes.get('/crm/profile/:phone', requirePerm('client_crm', 'can_view'), async (c) => {
  const phone = c.req.param('phone')
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 1000)
  const { data, error } = await db.rpc('crm_client_profile', { p_phone: phone, p_limit: limit })
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json(data)
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

    // What being on the list actually DOES. The page could already show 80
    // blocked numbers while nothing on it said whether that changed any
    // outcome — and until the gate went in, it did not: no function in the
    // decision path read the table. Served from the old project because
    // review_queue lives there and is not part of the delta sync.
    //
    // Best-effort: the list itself is the point of the page, so a failure to
    // compute enforcement must not take the whole page down with it.
    let enforcement: unknown = null
    const old = oldDb()
    if (old) {
      const { data, error: encErr } = await old.rpc('risk_enforcement_stats', { p_days: 7 })
      if (encErr) console.error('risk_enforcement_stats failed:', encErr.message)
      else enforcement = data
    }

    return c.json({
      blacklist: blacklist.data ?? [],
      sms: sms.data ?? [],
      clients: clients.data ?? [],
      enforcement,
    })
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
    // Scoped by (type, value) — the table's real key — not by value alone, and
    // NOT via .maybeSingle(): that errors out when more than one row matches,
    // and the error was being discarded, so a duplicate read as "not present"
    // and the insert went ahead. The upstream trigger had already piled up
    // thousands of duplicate rows before a unique index was added, which is
    // exactly the state this check silently mishandled.
    const { data: existing, error: existErr } = await db
      .from('api_risk_blacklist')
      .select('id')
      .eq('type', type)
      .eq('value', value)
      .limit(1)
    if (existErr) return c.json({ error: 'db_error', detail: existErr.message }, 500)
    if (existing?.length) return c.json({ error: 'already_blacklisted', id: existing[0].id }, 409)
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

extraRoutes.delete('/risk/blacklist/:id', requireAnyPerm(['risk', 'risk_audit', 'flagged', 'velocity', 'compliance'], 'can_edit'), async (c) => {
  const id = c.req.param('id'); const actor = c.get('actor')
  const { data, error } = await db.from('api_risk_blacklist').delete().eq('id', id).select('id, type, value').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'risk.blacklist_remove', entity: 'api_risk_blacklist', entity_id: String(id), before: data })
  return c.json({ ok: true, removed: data })
})

// ---- Automation: settings + rules + worker jobs + treasury ----
const RULE_COLS =
  'id, scope_type, master_merchant, merchant, sub_merchant, account_wallet, payment_method, provider, enabled, min_amount, max_amount, time_window_minutes, action_type, priority, use_crm_matching, use_near_amount, use_unique_amount, created_at, updated_at'

extraRoutes.get(
  '/automation',
  requireAnyPerm(
    ['automation', 'automation_rules', 'telegram_bot', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team'],
    'can_view',
  ),
  async (c) => {
    const [settings, rules, jobs, balances, rates] = await Promise.all([
      db.from('automation_settings').select('*').limit(1).maybeSingle(),
      db.from('automation_rules_scoped').select(RULE_COLS).order('priority', { ascending: false }).limit(100),
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

// Only the NGPay live evaluator (evaluate_and_dispatch_ngpay_decision, wired
// 2026-08-17) actually executes rule matches -- PayFuture has no execution
// worker on this project yet, so a rule scoped to it would only ever sit
// unenforced. Rules aren't restricted to master_merchant='ngpay' here (the
// evaluator itself hard-guards on gateway), but the UI should make this
// distinction obvious rather than implying both providers are live.
async function ruleConflict(db_: typeof db, scope_type: string, master_merchant: string | null, sub_merchant: string | null, priority: number, excludeId?: string) {
  let q = db_
    .from('automation_rules_scoped')
    .select('id, action_type, priority')
    .eq('enabled', true)
    .eq('scope_type', scope_type)
    .eq('priority', priority)
  q = master_merchant ? q.eq('master_merchant', master_merchant) : q.is('master_merchant', null)
  q = sub_merchant ? q.eq('sub_merchant', sub_merchant) : q.is('sub_merchant', null)
  if (excludeId) q = q.neq('id', excludeId)
  const { data } = await q
  return data ?? []
}

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function str(v: unknown, max = 80): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

extraRoutes.post('/automation/rules', requireAnyPerm(['automation_rules','automation'], 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const actor = c.get('actor')
  const scope_type = str(body?.scope_type, 20) ?? 'global'
  const action_type = body?.action_type === 'decline' ? 'decline' : 'approve'
  const min_amount = num(body?.min_amount) ?? 1
  const max_amount = num(body?.max_amount)
  const priority = num(body?.priority) ?? 0
  const time_window_minutes = num(body?.time_window_minutes) ?? 5
  if (max_amount == null || max_amount < min_amount) return c.json({ error: 'invalid_amount_range' }, 400)
  if (max_amount <= 0) return c.json({ error: 'maximum_amount_required' }, 400)
  if (action_type === 'decline' && time_window_minutes < 5) return c.json({ error: 'auto_decline_minimum_wait', minimum_minutes: 5 }, 400)

  const master_merchant = str(body?.master_merchant)
  const sub_merchant = str(body?.sub_merchant)
  if (body?.confirm_conflict !== true) {
    const conflicts = await ruleConflict(db, scope_type, master_merchant, sub_merchant, priority)
    if (conflicts.length) return c.json({ error: 'priority_conflict', conflicts }, 409)
  }

  const row = {
    scope_type, master_merchant, merchant: str(body?.merchant), sub_merchant, account_wallet: str(body?.account_wallet),
    payment_method: str(body?.payment_method), provider: str(body?.provider),
    min_amount, max_amount, time_window_minutes, action_type, priority,
    enabled: body?.enabled !== false,
    use_crm_matching: body?.use_crm_matching === true,
    use_near_amount: body?.use_near_amount === true,
    use_unique_amount: body?.use_unique_amount === true,
  }
  const { data, error } = await db.from('automation_rules_scoped').insert(row).select(RULE_COLS).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'automation.rule_created', entity: 'automation_rules_scoped', entity_id: data.id, after: row,
  })
  return c.json({ rule: data }, 201)
})

extraRoutes.patch('/automation/rules/:id', requireAnyPerm(['automation_rules','automation'], 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const actor = c.get('actor')
  const { data: before, error: beforeErr } = await db.from('automation_rules_scoped').select(RULE_COLS).eq('id', id).maybeSingle()
  if (beforeErr) return c.json({ error: 'db_error', detail: beforeErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body?.enabled !== undefined) update.enabled = body.enabled === true
  if (body?.priority !== undefined) update.priority = num(body.priority) ?? before.priority
  if (body?.min_amount !== undefined) update.min_amount = num(body.min_amount) ?? before.min_amount
  if (body?.max_amount !== undefined) update.max_amount = num(body.max_amount) ?? before.max_amount
  if (body?.time_window_minutes !== undefined) update.time_window_minutes = num(body.time_window_minutes) ?? before.time_window_minutes
  for (const key of ['use_crm_matching', 'use_near_amount', 'use_unique_amount'] as const) {
    if (body?.[key] !== undefined) update[key] = body[key] === true
  }

  const nextEnabled = (update.enabled as boolean | undefined) ?? before.enabled
  const nextPriority = (update.priority as number | undefined) ?? before.priority
  const nextMax = Number(update.max_amount ?? before.max_amount)
  const nextWindow = Number(update.time_window_minutes ?? before.time_window_minutes)
  if (!Number.isFinite(nextMax) || nextMax <= 0) return c.json({ error: 'maximum_amount_required' }, 400)
  if (before.action_type === 'decline' && nextWindow < 5) return c.json({ error: 'auto_decline_minimum_wait', minimum_minutes: 5 }, 400)
  if (nextEnabled && body?.confirm_conflict !== true && (update.priority !== undefined || update.enabled === true)) {
    const conflicts = await ruleConflict(db, before.scope_type, before.master_merchant, before.sub_merchant, nextPriority, id)
    if (conflicts.length) return c.json({ error: 'priority_conflict', conflicts }, 409)
  }

  const { data, error } = await db.from('automation_rules_scoped').update(update).eq('id', id).select(RULE_COLS).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'automation.rule_updated', entity: 'automation_rules_scoped', entity_id: id, before, after: data,
  })
  return c.json({ rule: data })
})

extraRoutes.delete('/automation/rules/:id', requireAnyPerm(['automation_rules','automation'], 'can_delete'), async (c) => {
  const id = c.req.param('id')
  const actor = c.get('actor')
  const { data: before } = await db.from('automation_rules_scoped').select(RULE_COLS).eq('id', id).maybeSingle()
  if (!before) return c.json({ error: 'not_found' }, 404)
  const { error } = await db.from('automation_rules_scoped').delete().eq('id', id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'automation.rule_deleted', entity: 'automation_rules_scoped', entity_id: id, before,
  })
  return c.json({ ok: true })
})

// Settings PATCH covers both the master kill switch (automation_enabled) and
// the SMS-matching circuit breaker as two genuinely independent toggles --
// disabling automation_enabled does not touch sms_feed_circuit_breaker_enabled
// (verified live today: SMS kept flowing while automation_enabled=false).
const SETTINGS_BOOL_FIELDS = [
  'automation_enabled', 'sms_feed_circuit_breaker_enabled', 'ngpay_enabled', 'payfuture_enabled',
  'balance_check_enabled', 'above_limit_to_manual', 'security_rules_enabled', 'wallet_switch_auto_enabled', 'turbo_mode',
  'use_crm_name_matching', 'use_near_amount_matching', 'use_unique_amount_matching', 'use_trxid_matching',
  'use_balance_timing_matching', 'use_wallet_verify_ocr', 'use_direct_field_matching', 'use_nameonly_ocr_matching', 'use_account_number_matching',
] as const

extraRoutes.patch('/automation/settings', requirePerm('automation', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const actor = c.get('actor')
  const { data: before, error: beforeErr } = await db.from('automation_settings').select('*').eq('id', 1).maybeSingle()
  if (beforeErr) return c.json({ error: 'db_error', detail: beforeErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)

  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actor.username }
  for (const key of SETTINGS_BOOL_FIELDS) {
    if (body?.[key] !== undefined) update[key] = body[key] === true
  }
  if (body?.max_auto_amount !== undefined) update.max_auto_amount = num(body.max_auto_amount) ?? before.max_auto_amount
  if (body?.decline_grace_minutes !== undefined) update.decline_grace_minutes = num(body.decline_grace_minutes) ?? before.decline_grace_minutes
  if (body?.score_threshold !== undefined) update.score_threshold = num(body.score_threshold) ?? before.score_threshold
  if (Object.keys(update).length <= 2) return c.json({ error: 'nothing_to_update' }, 400)

  const { data, error } = await db.from('automation_settings').update(update).eq('id', 1).select('*').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'automation.settings_updated', entity: 'automation_settings', entity_id: '1', before, after: data,
  })
  return c.json({ settings: data })
})

// Brand images are public assets, while their mapping is visible only inside
// an authenticated panel session. Latest audited upload per type/key wins.
extraRoutes.get('/branding', async (c) => {
  const { data, error } = await db.from('audit_log')
    .select('after, created_at')
    .eq('action', 'branding.logo_uploaded')
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const logos: Record<string, string> = {}
  for (const row of data ?? []) {
    const after = row.after as Record<string, unknown> | null
    const type = typeof after?.asset_type === 'string' ? after.asset_type : ''
    const key = typeof after?.asset_key === 'string' ? after.asset_key : ''
    const url = typeof after?.url === 'string' ? after.url : ''
    const mapKey = `${type}:${key.toLowerCase()}`
    if (type && key && url && !logos[mapKey]) logos[mapKey] = url
  }
  return c.json({ logos })
})

// ---- Mismatch detector ----
// Automates the two anomaly patterns found by hand today. Read-only: it
// surfaces suspects for a human, it never changes a transaction itself.
extraRoutes.get(
  '/mismatch',
  requireAnyPerm(['review', 'audit_log', 'audit-logs', 'risk', 'risk_audit', 'compliance'], 'can_view'),
  async (c) => {
    const hours = Math.min(Math.max(Number(c.req.query('hours')) || 24, 1), 720)
    const [undoc, counts, sms, decisions] = await Promise.all([
      db.rpc('panel_mismatch_undocumented', { p_hours: hours, p_limit: 100 }),
      db.rpc('panel_mismatch_undocumented_counts'),
      db.rpc('panel_mismatch_sms', { p_hours: Math.max(hours, 48), p_limit: 100 }),
      // A decision confirmed on the provider whose transaction still disagrees
      // 5+ minutes later. Silence here is what let a rolled-back status sit
      // unnoticed for 14-27 minutes.
      db.rpc('panel_mismatch_decisions', { p_grace_minutes: 5, p_hours: Math.max(hours, 72), p_limit: 100 }),
    ])
    const firstErr = undoc.error ?? counts.error ?? sms.error ?? decisions.error
    if (firstErr) return c.json({ error: 'db_error', detail: firstErr.message }, 500)

    // Sync gap vs the old project. Best-effort: if the old DB isn't reachable
    // the rest of the page must still render, so this degrades to null rather
    // than failing the whole request.
    let syncGap: Record<string, { old: number | null; current: number | null }> | null = null
    const old = oldDb()
    if (old) {
      try {
        const tables = ['api_risk_blacklist', 'crm_clients'] as const
        const pairs = await Promise.all(
          tables.map(async (tbl) => {
            const [o, n] = await Promise.all([
              old.from(tbl).select('*', { count: 'exact', head: true }),
              db.from(tbl).select('*', { count: 'exact', head: true }),
            ])
            return [tbl, { old: o.count ?? null, current: n.count ?? null }] as const
          }),
        )
        syncGap = Object.fromEntries(pairs)
      } catch {
        syncGap = null
      }
    }

    return c.json({
      undocumented: undoc.data ?? [],
      undocumentedCounts: Array.isArray(counts.data) ? counts.data[0] ?? null : counts.data ?? null,
      smsMismatch: sms.data ?? [],
      decisionMismatch: decisions.data ?? [],
      syncGap,
      hours,
    })
  },
)

// ---- Audit log ----
extraRoutes.get('/audit', requireAnyPerm(['audit_log', 'audit-logs'], 'can_view'), async (c) => {
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, MAX_PAGE)
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
  const [pendingDeposits, pendingDepositsStale, pendingPayouts, smsReview, devices, latestPending, latestPayouts, recentMatches, latestSms] = await Promise.all([
    countOf((q: any) => q.eq('status', 'PENDING').gte('first_seen_at', twoDays)),
    countOf((q: any) => q.eq('status', 'PENDING').lt('first_seen_at', twoDays)),
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
    // master_merchant is carried so the alert center can keep the live NGPay
    // and test-only PayFuture queues visually distinct, per the standing rule
    // that the two are never blended.
    db
      .from('maven_transactions')
      .select('tx_id, ontarget_ref, amount, currency, sender_name, merchant, master_merchant')
      .eq('status', 'PENDING')
      .gte('first_seen_at', twoDays)
      .order('ontarget_ref', { ascending: false, nullsFirst: false })
      .limit(5)
      .then(({ data }) => data ?? []),
    db
      .from('inbound_sms')
      .select('id, received_at, sms_category')
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => data ?? null),
    db
      .from('maven_payout_transactions')
      .select('maven_id, ontarget_ref, amount, account_name, mobile_no, merchant')
      .eq('status', 'PENDING')
      .order('ontarget_ref', { ascending: false, nullsFirst: false })
      .limit(5)
      .then(({ data }) => data ?? []),
    db
      .from('inbound_sms')
      .select('id, received_at, device_name, sender_name, amount, trx_id, matched_transaction_id')
      .eq('matched', true)
      .order('received_at', { ascending: false })
      .limit(5)
      .then(({ data }) => data ?? []),
  ])
  const offlineDevices = devices.filter((d) => !d.online).map((d) => d.device)

  // An operator who raised an edit request has no other way to learn it was
  // decided — the approval happens in Telegram or in someone else's panel. So
  // the requester gets their own settled requests back in their bell, scoped to
  // requests THEY raised. Two days keeps it a notification rather than a log.
  const { data: myDecided } = await db
    .from('transaction_edit_requests')
    .select('id, tx_id, ontarget_ref, status, decided_by, decided_at, decision_note, apply_error, requested_status, requested_amount')
    .eq('requested_by', c.get('actor').username)
    .neq('status', 'pending')
    .gte('decided_at', twoDays)
    .order('decided_at', { ascending: false })
    .limit(10)
  const myEditRequests = myDecided ?? []

  return c.json({
    pendingDeposits,
    pendingDepositsStale,
    pendingPayouts,
    smsReview,
    offlineDevices,
    latestPending,
    latestPayouts,
    recentMatches,
    latestSms,
    myEditRequests,
    total:
      pendingDeposits + pendingPayouts + (smsReview > 0 ? 1 : 0) +
      (offlineDevices.length > 0 ? 1 : 0) + myEditRequests.length,
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
    const from = c.req.query('from')?.trim() || new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)
    const to = c.req.query('to')?.trim() || new Date().toISOString().slice(0, 10)
    const merchantFilter = c.req.query('merchant')?.trim() || ''
    const methodFilter = c.req.query('method')?.trim() || ''
    const statusFilter = c.req.query('status')?.trim() || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return c.json({ error: 'invalid_date_range' }, 400)
    const since = `${from}T00:00:00+03:00`
    const until = `${to}T23:59:59.999+03:00`
    const day = new Date(Date.now() - 24 * 86_400_000).toISOString()
    const [deposits, payouts, pendingDeposits, pendingPayouts, devices, sms] = await Promise.all([
      db.from('maven_transactions').select('amount, status, merchant, master_merchant, payment_method, gateway, fees, commission, first_seen_at').gte('first_seen_at', since).lte('first_seen_at', until).order('first_seen_at', { ascending: true, nullsFirst: false }).limit(20_000),
      db.from('maven_payout_transactions').select('amount, status, merchant, first_seen_at').gte('first_seen_at', since).lte('first_seen_at', until).order('first_seen_at', { ascending: true, nullsFirst: false }).limit(20_000),
      db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
      db.from('maven_payout_transactions').select('maven_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
      db.from('device_status').select('device, sim_slot, online, battery, last_seen_at').order('device').limit(500),
      db.from('inbound_sms').select('id, matched, sms_category, received_at').gte('received_at', day).order('received_at', { ascending: false, nullsFirst: false }).limit(1_000),
    ])
    for (const result of [deposits, payouts, pendingDeposits, pendingPayouts, devices, sms]) {
      if (result.error) return c.json({ error: 'db_error', detail: result.error.message }, 500)
    }

    const rawDeposits = deposits.data ?? []
    const rawPayouts = payouts.data ?? []
    const options = {
      merchants: [...new Set(rawDeposits.map((row) => row.master_merchant ?? row.merchant ?? 'Unassigned'))].sort(),
      methods: [...new Set(rawDeposits.map((row) => row.payment_method ?? row.gateway ?? 'Unspecified'))].sort(),
      statuses: [...new Set(rawDeposits.map((row) => row.status ?? 'PENDING'))].sort(),
    }
    const depositRows = rawDeposits.filter((row) => {
      const merchant = row.master_merchant ?? row.merchant ?? 'Unassigned'
      const method = row.payment_method ?? row.gateway ?? 'Unspecified'
      return (!merchantFilter || merchant === merchantFilter) && (!methodFilter || method === methodFilter) && (!statusFilter || row.status === statusFilter)
    })
    // Payouts do not have a payment_method column. When a method filter is
    // active, omit them instead of silently attributing unclassified payouts
    // to the selected deposit method.
    const payoutRows = methodFilter ? [] : rawPayouts.filter((row) => (!merchantFilter || (row.merchant ?? 'Unassigned') === merchantFilter) && (!statusFilter || row.status === statusFilter))
    const isApproved = (status: string | null) => status === 'PAID' || status === 'APPROVED'
    const approvedDep = depositRows.filter((row) => isApproved(row.status))
    const approvedPay = payoutRows.filter((row) => isApproved(row.status))
    const summary = {
      depositCount: approvedDep.length,
      depositVolume: approvedDep.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      payoutCount: approvedPay.length,
      payoutVolume: approvedPay.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
      declined: depositRows.filter((row) => row.status === 'DECLINED').length,
      pending: depositRows.filter((row) => row.status === 'PENDING').length,
      attempts: depositRows.length,
      fees: depositRows.reduce((sum, row) => sum + Number(row.fees ?? 0) + Number(row.commission ?? 0), 0),
    }
    const pivot = new Map<string, { merchant: string; method: string; paidCount: number; paidVolume: number; pendingCount: number; pendingVolume: number; declinedCount: number; declinedVolume: number; totalCount: number; totalVolume: number }>()
    for (const row of depositRows) {
      const merchant = row.master_merchant ?? row.merchant ?? 'Unassigned'
      const method = row.payment_method ?? row.gateway ?? 'Unspecified'
      const key = `${merchant}\u0000${method}`
      const bucket = pivot.get(key) ?? { merchant, method, paidCount: 0, paidVolume: 0, pendingCount: 0, pendingVolume: 0, declinedCount: 0, declinedVolume: 0, totalCount: 0, totalVolume: 0 }
      const amount = Number(row.amount ?? 0)
      bucket.totalCount += 1; bucket.totalVolume += amount
      if (isApproved(row.status)) { bucket.paidCount += 1; bucket.paidVolume += amount }
      else if (row.status === 'PENDING') { bucket.pendingCount += 1; bucket.pendingVolume += amount }
      else if (row.status === 'DECLINED') { bucket.declinedCount += 1; bucket.declinedVolume += amount }
      pivot.set(key, bucket)
    }
    const daily = new Map<string, { date: string; incoming: number; outgoing: number }>()
    const dailyRow = (date: string) => {
      if (!daily.has(date)) daily.set(date, { date, incoming: 0, outgoing: 0 })
      return daily.get(date)!
    }
    for (const row of depositRows) {
      if (isApproved(row.status) && row.first_seen_at) dailyRow(row.first_seen_at.slice(0, 10)).incoming += Number(row.amount ?? 0)
    }
    for (const row of payoutRows) {
      if (isApproved(row.status) && row.first_seen_at) dailyRow(row.first_seen_at.slice(0, 10)).outgoing += Number(row.amount ?? 0)
    }
    const deviceRows = devices.data ?? []
    const liveSms = sms.data ?? []
    return c.json({
      generatedAt: new Date().toISOString(),
      range: { from, to },
      filters: { merchant: merchantFilter || null, method: methodFilter || null, status: statusFilter || null },
      options,
      summary,
      queues: { pendingDeposits: pendingDeposits.count ?? 0, pendingPayouts: pendingPayouts.count ?? 0, smsReview: liveSms.filter((row) => !row.matched && (row.sms_category === 'deposit' || row.sms_category === 'withdrawal')).length },
      devices: { total: deviceRows.length, online: deviceRows.filter((row) => row.online).length, rows: deviceRows.slice(0, 20) },
      pivot: [...pivot.values()].sort((a, b) => b.totalVolume - a.totalVolume),
      daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)),
    })
  },
)

// ---- System health ----
//
// Every number here is derived from data we actually hold. There are no CPU,
// RAM or disk gauges: those belong to Supabase's own infrastructure metrics and
// we have no truthful source for them from inside the app. Inventing a dial to
// fill a grid would make the page look authoritative while being fiction, and
// this page exists to be trusted during an incident.
extraRoutes.get('/system-health', async (c) => {
  const now = Date.now()
  const dayAgo = new Date(now - 86_400_000).toISOString()

  const [txRows, smsRows, devices, tgAlerts, pendingPayouts, editRequests, manualGap] = await Promise.all([
    db.from('maven_transactions')
      .select('status, gateway, first_seen_at, last_status_change')
      .gte('first_seen_at', dayAgo).limit(5000)
      .then(({ data }) => data ?? []),
    db.from('inbound_sms')
      .select('received_at, matched, sms_category, webhook_name, device_name')
      .gte('received_at', dayAgo).limit(5000)
      .then(({ data }) => data ?? []),
    // Device telemetry is written on the old project by the phones themselves
    // and is NOT part of the delta sync, so this table holds 1 row here against
    // 7 there. Read it at the source — a health page showing one device when
    // seven are running would be worse than not showing the section at all.
    (async () => {
      const cols = 'device, sim_number, operator, battery, charging, net_type, online, balance, balance_at, last_seen_at'
      const old = oldDb()
      if (old) {
        const { data, error } = await old.from('device_status').select(cols).order('device')
        if (!error && data) return data
      }
      const { data } = await db.from('device_status').select(cols).order('device')
      return data ?? []
    })(),
    db.from('telegram_alerts')
      .select('alert_type, ok, error, created_at')
      .gte('created_at', dayAgo).limit(500)
      .then(({ data }) => data ?? []),
    db.from('maven_payout_transactions')
      .select('maven_id', { count: 'exact', head: true }).eq('status', 'PENDING')
      .then(({ count }) => count ?? 0),
    db.from('transaction_edit_requests')
      .select('status').gte('created_at', dayAgo)
      .then(({ data }) => data ?? []),
    // Transactions approved by hand with NO SMS evidence (match_score = 0).
    // This is the true size of the daily manual workload and the number that
    // must fall if device coverage improves — an approval rate cannot show it,
    // because these all end up approved either way.
    //
    // Read at the source: review_queue lives on the old project and is not
    // part of the delta sync. Best-effort, so a failure here cannot take the
    // health page down with it.
    (async () => {
      const old = oldDb()
      if (!old) return null
      const { data, error } = await old.rpc('manual_approval_gap_stats', { p_days: 14 })
      if (error) { console.error('manual_approval_gap_stats failed:', error.message); return null }
      return data
    })(),
  ])

  // Hourly buckets, oldest first, so a flat line reads as "quiet" and a gap
  // reads as "nothing arrived" rather than being silently dropped.
  const hours: string[] = []
  for (let i = 23; i >= 0; i--) hours.push(new Date(now - i * 3_600_000).toISOString().slice(0, 13))
  const bucket = (iso: string | null | undefined) => (iso ? iso.slice(0, 13) : null)

  const txByHour = hours.map((h) => ({ hour: h, paid: 0, declined: 0, pending: 0, other: 0 }))
  const txIndex = new Map(txByHour.map((b, i) => [b.hour, i]))
  for (const r of txRows) {
    const i = txIndex.get(bucket(r.first_seen_at as string) ?? '')
    if (i == null) continue
    const s = String(r.status ?? '').toUpperCase()
    if (s === 'PAID') txByHour[i].paid++
    else if (s === 'DECLINED') txByHour[i].declined++
    else if (s === 'PENDING') txByHour[i].pending++
    else txByHour[i].other++
  }

  const smsByHour = hours.map((h) => ({ hour: h, total: 0, matched: 0 }))
  const smsIndex = new Map(smsByHour.map((b, i) => [b.hour, i]))
  for (const r of smsRows) {
    const i = smsIndex.get(bucket(r.received_at as string) ?? '')
    if (i == null) continue
    smsByHour[i].total++
    if (r.matched) smsByHour[i].matched++
  }

  const deposits = smsRows.filter((r) => r.sms_category === 'deposit')
  const matchedDeposits = deposits.filter((r) => r.matched).length
  const onlineDevices = devices.filter((d) => d.online).length
  const tgOk = tgAlerts.filter((a) => a.ok).length

  const newestTx = txRows.reduce<string | null>((acc, r) => {
    const v = r.first_seen_at as string | null
    return v && (!acc || v > acc) ? v : acc
  }, null)
  const newestSms = smsRows.reduce<string | null>((acc, r) => {
    const v = r.received_at as string | null
    return v && (!acc || v > acc) ? v : acc
  }, null)

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)
  const ageSec = (iso: string | null) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null)

  return c.json({
    generatedAt: new Date(now).toISOString(),
    gauges: {
      // null means "nothing happened in the window", which the UI shows as no
      // data rather than as a confident 0% or 100%.
      smsMatchRate: { value: pct(matchedDeposits, deposits.length), of: deposits.length, unit: '%' },
      // A COUNT, not a success rate. Operations often run a single device
      // while the rest sit deliberately off, so "1 of 7" is normal — expressed
      // as a percentage it read 14% and the tile banded itself permanently
      // red. The UI renders this one neutral (see GaugeTile `neutral`).
      devicesOnline: { value: onlineDevices, of: devices.length, unit: '' },
      telegramDelivery: { value: pct(tgOk, tgAlerts.length), of: tgAlerts.length, unit: '%' },
      approvalRate: {
        value: pct(
          txByHour.reduce((a, b) => a + b.paid, 0),
          txByHour.reduce((a, b) => a + b.paid + b.declined, 0),
        ),
        of: txByHour.reduce((a, b) => a + b.paid + b.declined, 0),
        unit: '%',
      },
    },
    freshness: {
      newestTransactionAgeSec: ageSec(newestTx),
      newestSmsAgeSec: ageSec(newestSms),
    },
    queues: {
      pendingDeposits: txByHour.reduce((a, b) => a + b.pending, 0),
      pendingPayouts,
      editRequestsPending: editRequests.filter((r) => r.status === 'pending').length,
    },
    series: { txByHour, smsByHour },
    // Null when the source is unreachable, so the UI can say "no data"
    // instead of rendering a confident zero for work that did happen.
    manualGap,
    devices,
    telegram: Object.values(
      tgAlerts.reduce<Record<string, { alert_type: string; ok: number; failed: number; lastError: string | null }>>((acc, a) => {
        const k = String(a.alert_type)
        acc[k] ??= { alert_type: k, ok: 0, failed: 0, lastError: null }
        if (a.ok) acc[k].ok++
        else { acc[k].failed++; acc[k].lastError = (a.error as string) ?? acc[k].lastError }
        return acc
      }, {}),
    ),
  })
})

// ---- Settlement batches: gross per sub-merchant, with the rate ambiguity ----
//
// Gross only, on purpose. maven_transactions.commission and .fees are NULL on
// every paid row, and the configured rates cannot be applied unambiguously:
// merchants_hierarchy.commission_rate disagrees with payin+payout on EVERY
// row, and rate rows match sub-merchants by name rather than by key. A
// settlement figure is a payable amount, so the endpoint reports what is
// certain and flags what is not, instead of picking a rate and calling the
// result a number.
extraRoutes.get(
  '/settlements/batches',
  requireAnyPerm(['settlements', 'settlements_list', 'settlement_recon', 'fees', 'reports'], 'can_view'),
  async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365)
    const gateway = c.req.query('gateway') === 'ALL' ? 'ALL' : 'NagupayP2P'
    const { data, error } = await db.rpc('settlement_batches', { p_days: days, p_gateway: gateway })
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    return c.json(data)
  },
)
