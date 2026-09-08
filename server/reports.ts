import { Hono } from 'hono'
import { db } from './db.js'
import { requireAnyPerm, requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'
import { sendTelegramAlert } from './notify.js'

export const reportsRoutes = new Hono<AuthEnv>()
reportsRoutes.use('*', requireAuth)

const DEPOSIT_STATUSES = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'EXPIRED_LOCAL', 'UNDERPAID']
const PAYOUT_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'PAID', 'EXPIRED', 'EXPIRED_LOCAL', 'UNDERPAID']
type Tx = { tx_id: number; ontarget_ref: string | null; amount: number | null; status: string | null; merchant: string | null; sub_merchant: string | null; master_merchant: string | null; payment_method: string | null; gateway: string | null; receiving_wallet: string | null; to_account_number: string | null; first_seen_at: string | null }
type Payout = { amount: number | null; status: string | null; merchant: string | null; first_seen_at: string | null }
type GroupKpi = { key: string; label: string; count: number; amount: number; linked: number; unlinked: number; latest_balance: number | null }
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '')
const within = (value: unknown, start: Date, end: Date) => {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) && time >= start.getTime() && time <= end.getTime()
}

// Withdrawal SMS reports are read frequently while operators work the queue.
// Keep a very short, per-actor cache so refreshes/navigation do not re-scan
// every historical SMS row on each request. The TTL is intentionally small so
// the report remains effectively live.
const withdrawalReportCache = new Map<string, { expires: number; body: unknown }>()
const WITHDRAWAL_REPORT_TTL_MS = 10_000
const WITHDRAWAL_REPORT_CACHE_MAX = 40

function params(c: any) {
  const from = c.req.query('from')?.trim() || null
  const to = c.req.query('to')?.trim() || null
  const merchant = c.req.query('merchant')?.trim() || null
  const status = c.req.query('status')?.trim().toUpperCase() || null
  const sms = ['linked', 'unlinked'].includes(c.req.query('sms')) ? c.req.query('sms') : null
  return { from, to, merchant, status, sms }
}
async function fetchAll<T>(query: any): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < 100_000; offset += 1_000) {
    const { data, error } = await query.range(offset, offset + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1_000) break
  }
  return rows
}
async function buildReport(c: any) {
  const { from, to, merchant, status, sms } = params(c)
  let deposits = db.from('maven_transactions').select('tx_id, ontarget_ref, amount, status, merchant, sub_merchant, master_merchant, payment_method, gateway, receiving_wallet, to_account_number, first_seen_at').order('first_seen_at', { ascending: true, nullsFirst: false })
  let payouts = db.from('maven_payout_transactions').select('amount, status, merchant, first_seen_at').order('first_seen_at', { ascending: true, nullsFirst: false })
  if (from) { deposits = deposits.gte('first_seen_at', `${from}T00:00:00Z`); payouts = payouts.gte('first_seen_at', `${from}T00:00:00Z`) }
  if (to) { deposits = deposits.lte('first_seen_at', `${to}T23:59:59Z`); payouts = payouts.lte('first_seen_at', `${to}T23:59:59Z`) }
  if (merchant) deposits = deposits.eq('merchant', merchant)
  if (status) deposits = deposits.eq('status', status)
  const [rawDeposits, payoutRows, wallets, smsRows] = await Promise.all([
    fetchAll<Tx>(deposits), fetchAll<Payout>(payouts),
    fetchAll<{ to_account_number: string | null }>(db.from('wallet_device_map').select('to_account_number').order('to_account_number')),
    fetchAll<{ id: number; amount: number | null; sms_category: string | null; consumed_by_tx_id: number | null; received_at: string | null }>((() => { let q = db.from('inbound_sms').select('id, amount, sms_category, consumed_by_tx_id, received_at').order('received_at', { ascending: true, nullsFirst: false }); if (from) q = q.gte('received_at', `${from}T00:00:00Z`); if (to) q = q.lte('received_at', `${to}T23:59:59Z`); return q })()),
  ])
  const linkedIds = new Set(smsRows.filter((row) => row.consumed_by_tx_id != null).map((row) => Number(row.consumed_by_tx_id)))
  const depRows = sms === 'linked' ? rawDeposits.filter((row) => linkedIds.has(row.tx_id)) : sms === 'unlinked' ? rawDeposits.filter((row) => !linkedIds.has(row.tx_id)) : rawDeposits
  const empty = (statuses: string[]) => Object.fromEntries(statuses.map((status) => [status, { count: 0, amount: 0 }]))
  const depositStatuses = empty(DEPOSIT_STATUSES)
  const payoutStatuses = empty(PAYOUT_STATUSES)
  const byMaster = new Map<string, { master: string; count: number; amount: number }>()
  const byMethod = new Map<string, { method: string; master: string; count: number; amount: number }>()
  const daily = new Map<string, { date: string; deposits: number; payouts: number; count: number }>()
  let includesPayFuture = false
  let ngpayPaid = 0
  let unassigned = { count: 0, amount: 0 }
  const merchants = new Set<string>()
  for (const row of depRows) {
    if (row.merchant) merchants.add(row.merchant)
    const status = row.status ?? 'PENDING'; const amount = Number(row.amount ?? 0)
    if (/^ngpay$/i.test(row.master_merchant ?? '') && (status === 'PAID' || status === 'APPROVED')) ngpayPaid += amount
    if (row.master_merchant == null) { unassigned.count += 1; unassigned.amount += amount }
    if (!depositStatuses[status]) depositStatuses[status] = { count: 0, amount: 0 }
    depositStatuses[status].count += 1; depositStatuses[status].amount += amount
    const master = row.master_merchant ?? 'Unassigned'
    if (/payfuture/i.test(master)) includesPayFuture = true
    const masterBucket = byMaster.get(master) ?? { master, count: 0, amount: 0 }
    masterBucket.count += 1; masterBucket.amount += amount; byMaster.set(master, masterBucket)
    const method = row.payment_method ?? row.gateway ?? 'Unspecified'
    const key = `${method}||${master}`
    const methodBucket = byMethod.get(key) ?? { method, master, count: 0, amount: 0 }
    methodBucket.count += 1; methodBucket.amount += amount; byMethod.set(key, methodBucket)
    const date = row.first_seen_at?.slice(0, 10)
    if (date) { const bucket = daily.get(date) ?? { date, deposits: 0, payouts: 0, count: 0 }; bucket.deposits += amount; bucket.count += 1; daily.set(date, bucket) }
  }
  let approvedPayouts = 0
  for (const row of payoutRows) {
    const status = row.status ?? 'PENDING'; const amount = Number(row.amount ?? 0)
    if (status === 'APPROVED') approvedPayouts += amount
    if (!payoutStatuses[status]) payoutStatuses[status] = { count: 0, amount: 0 }
    payoutStatuses[status].count += 1; payoutStatuses[status].amount += amount
    const date = row.first_seen_at?.slice(0, 10)
    if (date) { const bucket = daily.get(date) ?? { date, deposits: 0, payouts: 0, count: 0 }; bucket.payouts += amount; daily.set(date, bucket) }
  }
  // maven_payout_transactions has no master_merchant column, so payout totals
  // cannot be split per provider — the UI must disclose that instead of
  // silently attributing everything to NGPay.
  const hero = { ngpayPaid, approvedPayouts, net: ngpayPaid - approvedPayouts, payoutsUnclassified: true }
  const paid = depRows.filter((row) => ['PAID', 'APPROVED'].includes(row.status ?? ''))
  const paidVolume = paid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const linkedPaid = paid.filter((row) => linkedIds.has(row.tx_id)).length
  const settled = depRows.filter((row) => ['PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'EXPIRED_LOCAL'].includes(row.status ?? ''))
  const financialSms = smsRows.filter((row) => row.sms_category === 'deposit' || row.sms_category === 'withdrawal')
  const matchedSms = financialSms.filter((row) => row.consumed_by_tx_id != null).length
  const outgoingRows = financialSms.filter((row) => row.sms_category === 'withdrawal')
  const live = {
    updatedAt: new Date().toISOString(), paidVolume, paidCount: paid.length,
    successRate: settled.length ? paid.length / settled.length * 100 : 0,
    linkedPaid, declinedCount: depRows.filter((row) => row.status === 'DECLINED').length,
    activeWallets: new Set(wallets.map((row) => row.to_account_number).filter(Boolean)).size,
    walletRows: wallets.length, smsCoverage: financialSms.length ? matchedSms / financialSms.length * 100 : 0,
    matchedSms, outgoingAmount: outgoingRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0), outgoingCount: outgoingRows.length,
    recent: [...depRows].sort((a, b) => String(b.first_seen_at).localeCompare(String(a.first_seen_at))).slice(0, 30).map((row) => ({ ...row, sms_linked: linkedIds.has(row.tx_id) })),
  }
  return { from, to, merchant, status, sms, merchants: [...merchants].sort(), hero, live, unassigned, depositStatuses, payoutStatuses, byMaster: [...byMaster.values()].sort((a, b) => b.amount - a.amount), byMethod: [...byMethod.values()].sort((a, b) => b.amount - a.amount), daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)), includesPayFuture }
}
const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`

reportsRoutes.get('/withdrawal-sms', requireAnyPerm(['reports', 'advanced_analysis', 'sms_live'], 'can_view'), async (c) => {
  const from = c.req.query('from')?.trim() || null
  const to = c.req.query('to')?.trim() || null
  const wallet = c.req.query('wallet')?.trim() || null
  const provider = c.req.query('provider')?.trim() || null
  const link = c.req.query('link')?.trim() || null
  const q = c.req.query('q')?.trim() || null
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  const actor = c.get('actor')
  const cacheKey = JSON.stringify({ actor: actor.sub, role: actor.role, from, to, wallet, provider, link, q, limit, offset })
  const cached = withdrawalReportCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return c.json(cached.body)
  if (cached) withdrawalReportCache.delete(cacheKey)
  const columns = 'id, received_at, device_name, sim_slot, receiver_number, wallet_number, confirmed_wallet_number, provider, amount, balance_after, matched, match_status, consumed_by_tx_id, matched_transaction_id, trx_id, trx_reference, sender_name, sender_number, sms_first_line'
  const apply = (base: any) => {
    let query = base.eq('sms_category', 'withdrawal')
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) query = query.gte('received_at', `${from}T00:00:00+03:00`)
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) query = query.lte('received_at', `${to}T23:59:59.999+03:00`)
    if (provider) query = query.ilike('provider', `%${provider.replaceAll(',', ' ')}%`)
    if (wallet) query = query.or(`confirmed_wallet_number.ilike.%${wallet.replaceAll(',', ' ')}%,wallet_number.ilike.%${wallet.replaceAll(',', ' ')}%,receiver_number.ilike.%${wallet.replaceAll(',', ' ')}%`)
    if (link === 'linked') query = query.or('matched.eq.true,consumed_by_tx_id.not.is.null,matched_transaction_id.not.is.null')
    if (link === 'unlinked') query = query.or('matched.eq.false,matched.is.null').is('consumed_by_tx_id', null).is('matched_transaction_id', null)
    if (q) query = query.or(`trx_id.ilike.%${q.replaceAll(',', ' ')}%,trx_reference.ilike.%${q.replaceAll(',', ' ')}%,sender_name.ilike.%${q.replaceAll(',', ' ')}%,sms_first_line.ilike.%${q.replaceAll(',', ' ')}%`)
    return query
  }
  try {
    const [pageResult, allRows] = await Promise.all([
      apply(db.from('inbound_sms').select(columns, { count: 'exact' })).order('received_at', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1),
      fetchAll<any>(apply(db.from('inbound_sms').select('id, amount, balance_after, matched, consumed_by_tx_id, matched_transaction_id, confirmed_wallet_number, wallet_number, receiver_number, provider, sender_name, sender_number').order('id', { ascending: true }))),
    ])
    if (pageResult.error) throw new Error(pageResult.error.message)
    const linked = (row: any) => row.matched === true || row.consumed_by_tx_id != null || row.matched_transaction_id != null
    const rows = (pageResult.data ?? []).map((row: any) => ({ ...row, linked: linked(row), wallet: row.confirmed_wallet_number ?? row.wallet_number ?? row.receiver_number ?? null }))
    const linkedCount = allRows.filter(linked).length
    const withBalance = allRows.filter((row) => row.balance_after != null).length
    const providers = [...new Set(allRows.map((row) => row.provider).filter(Boolean))].sort()
    const wallets = [...new Set(allRows.map((row) => row.confirmed_wallet_number ?? row.wallet_number ?? row.receiver_number).filter(Boolean))]
    const grouped = (keyOf: (row: any) => string | null): GroupKpi[] => {
      const groups = new Map<string, GroupKpi>()
      for (const row of allRows) {
        const label = keyOf(row)
        if (!label) continue
        const key = label.replace(/\D/g, '') || label.toLowerCase()
        const item = groups.get(key) ?? { key, label, count: 0, amount: 0, linked: 0, unlinked: 0, latest_balance: null }
        item.count += 1; item.amount += Number(row.amount ?? 0)
        if (linked(row)) item.linked += 1; else item.unlinked += 1
        if (row.balance_after != null) item.latest_balance = Number(row.balance_after)
        groups.set(key, item)
      }
      return [...groups.values()].sort((a, b) => b.amount - a.amount || b.count - a.count)
    }
    const body = {
      rows, total: pageResult.count ?? 0, limit, offset, providers,
      kpis: {
        count: allRows.length,
        amount: allRows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
        linked: linkedCount,
        unlinked: allRows.length - linkedCount,
        coverage: allRows.length ? linkedCount / allRows.length * 100 : 0,
        wallets: wallets.length,
        with_balance: withBalance,
      },
      wallet_kpis: grouped((row) => row.confirmed_wallet_number ?? row.wallet_number ?? row.receiver_number),
      sender_kpis: grouped((row) => row.sender_name || row.sender_number || null),
    }
    withdrawalReportCache.set(cacheKey, { expires: Date.now() + WITHDRAWAL_REPORT_TTL_MS, body })
    if (withdrawalReportCache.size > WITHDRAWAL_REPORT_CACHE_MAX) {
      const oldest = withdrawalReportCache.keys().next().value
      if (oldest) withdrawalReportCache.delete(oldest)
    }
    return c.json(body)
  } catch (error) {
    return c.json({ error: 'db_error', detail: (error as Error).message }, 500)
  }
})

reportsRoutes.get('/', requireAnyPerm(['reports', 'advanced_analysis'], 'can_view'), async (c) => {
  try { return c.json(await buildReport(c)) } catch (error) { return c.json({ error: 'db_error', detail: (error as Error).message }, 500) }
})

reportsRoutes.get('/export', requireAnyPerm(['reports', 'advanced_analysis'], 'can_export'), async (c) => {
  try {
    const report = await buildReport(c)
    const rows = [
      ['section', 'key', 'secondary_key', 'status', 'count', 'amount'],
      ...Object.entries(report.depositStatuses).map(([status, value]) => ['deposits', '', '', status, value.count, value.amount]),
      ...Object.entries(report.payoutStatuses).map(([status, value]) => ['payouts', '', '', status, value.count, value.amount]),
      ...report.byMaster.map((row) => ['master_merchant', row.master, '', '', row.count, row.amount]),
      ...report.byMethod.map((row) => ['payment_method', row.method, row.master, '', row.count, row.amount]),
      ...report.daily.map((row) => ['daily', row.date, '', '', row.count, row.deposits - row.payouts]),
    ]
    return new Response(rows.map((row) => row.map(esc).join(',')).join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ontarget-report.csv"' } })
  } catch (error) { return c.json({ error: 'db_error', detail: (error as Error).message }, 500) }
})

const STAFF_ROLES = new Set(['agent', 'operator', 'operations_admin', 'operator_admin', 'operation_admin'])
const ADMIN_ROLES = new Set(['owner', 'admin', 'super_admin'])

function reportDate(value: string | undefined, fallback: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}

reportsRoutes.get('/attendance/me', requireAuth, async (c) => {
  const actor = c.get('actor')
  if (!STAFF_ROLES.has(actor.role)) return c.json({ active_session: null })
  const { data, error } = await db.from('staff_attendance_sessions').select('id, user_id, wallet_number, checked_in_at, checked_out_at, note').eq('user_id', actor.sub).is('checked_out_at', null).order('checked_in_at', { ascending: false }).limit(1).maybeSingle()
  if (error) return c.json({ error: 'attendance_status_failed', detail: error.message }, 500)
  return c.json({ active_session: data ?? null })
})

reportsRoutes.get('/attendance', requireAnyPerm(['reports', 'advanced_analysis', 'users'], 'can_view'), async (c) => {
  const now = new Date()
  const from = reportDate(c.req.query('from'), now.toISOString().slice(0, 10))
  const to = reportDate(c.req.query('to'), from)
  const userId = c.req.query('user_id')?.trim() || null
  const wallet = c.req.query('wallet')?.replace(/\D/g, '') || null
  const [usersResult, sessionsResult, txResult, payoutResult, smsResult] = await Promise.all([
    db.from('panel_users').select('id, username, display_name, role').in('role', [...STAFF_ROLES]).order('username'),
    db.from('staff_attendance_sessions').select('id, user_id, wallet_number, checked_in_at, checked_out_at, note').gte('checked_in_at', `${from}T00:00:00+03:00`).lte('checked_in_at', `${to}T23:59:59.999+03:00`).order('checked_in_at', { ascending: false }).limit(5000),
    db.from('maven_transactions').select('tx_id, amount, status, approved_by, agent_name, receiving_wallet, to_account_number, first_seen_at').gte('first_seen_at', `${from}T00:00:00+03:00`).lte('first_seen_at', `${to}T23:59:59.999+03:00`).limit(50000),
    db.from('maven_payout_transactions').select('maven_id, amount, status, agent_name, mobile_no, first_seen_at').gte('first_seen_at', `${from}T00:00:00+03:00`).lte('first_seen_at', `${to}T23:59:59.999+03:00`).limit(50000),
    db.from('inbound_sms').select('id, amount, sms_category, receiver_number, wallet_number, balance_after, received_at').gte('received_at', `${from}T00:00:00+03:00`).lte('received_at', `${to}T23:59:59.999+03:00`).limit(50000),
  ])
  const firstError = usersResult.error || sessionsResult.error || txResult.error || payoutResult.error || smsResult.error
  if (firstError) return c.json({ error: 'db_error', detail: firstError.message }, 500)
  const users = usersResult.data ?? []
  const sessions = (sessionsResult.data ?? []).filter((row) => !userId || row.user_id === userId).filter((row) => !wallet || String(row.wallet_number ?? '').replace(/\D/g, '') === wallet)
  const nameOf = (user: typeof users[number]) => `${user.username} ${user.display_name ?? ''}`.toLowerCase().trim()
  const nameMatches = (value: unknown, names: string) => {
    const candidate = String(value ?? '').toLowerCase().trim()
    return Boolean(candidate && (candidate === names || names.includes(candidate) || candidate.includes(names)))
  }
  const stats = users.filter((user) => !userId || user.id === userId).map((user) => {
    const names = nameOf(user)
    const mine = sessions.filter((row) => row.user_id === user.id)
    const wallets = new Set(mine.map((row) => String(row.wallet_number ?? '').replace(/\D/g, '')).filter(Boolean))
    const txs = (txResult.data ?? []).filter((row) => nameMatches(row.agent_name, names) && (!wallet || digits(row.receiving_wallet ?? row.to_account_number) === wallet))
    const sms = (smsResult.data ?? []).filter((row) => !wallet || String(row.wallet_number ?? row.receiver_number ?? '').replace(/\D/g, '') === wallet)
    const paid = txs.filter((row) => ['PAID', 'APPROVED'].includes(String(row.status ?? '').toUpperCase()))
    const open = mine.find((row) => !row.checked_out_at)
    const sessionReports = mine.map((session) => {
      const start = new Date(session.checked_in_at)
      const end = new Date(session.checked_out_at ?? now.toISOString())
      const sessionWallet = digits(session.wallet_number)
      const sessionTxs = txs.filter((row) => within(row.first_seen_at, start, end))
      const sessionPaid = sessionTxs.filter((row) => ['PAID', 'APPROVED'].includes(String(row.status ?? '').toUpperCase()))
      const sessionAuto = sessionPaid.filter((row) => /^(auto|automation|system)/i.test(String(row.approved_by ?? '').trim()))
      const sessionWithdrawals = (payoutResult.data ?? []).filter((row) => nameMatches(row.agent_name, names) && within(row.first_seen_at, start, end))
      const balanceRows = (smsResult.data ?? []).filter((row) => row.balance_after != null && (!sessionWallet || digits(row.wallet_number ?? row.receiver_number) === sessionWallet)).sort((a, b) => Date.parse(String(a.received_at ?? '')) - Date.parse(String(b.received_at ?? '')))
      const beforeStart = balanceRows.filter((row) => Date.parse(String(row.received_at ?? '')) <= start.getTime()).at(-1)
      const beforeEnd = balanceRows.filter((row) => Date.parse(String(row.received_at ?? '')) <= end.getTime()).at(-1)
      const balanceStart = beforeStart?.balance_after == null ? null : Number(beforeStart.balance_after)
      const balanceEnd = beforeEnd?.balance_after == null ? null : Number(beforeEnd.balance_after)
      return {
        ...session,
        metrics: {
          approved_count: sessionPaid.length,
          approved_amount: sessionPaid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
          automation_count: sessionAuto.length,
          automation_amount: sessionAuto.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
          withdrawal_count: sessionWithdrawals.length,
          withdrawal_amount: sessionWithdrawals.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
          wallet: session.wallet_number,
          balance_start: balanceStart,
          balance_end: balanceEnd,
          net_balance: balanceStart == null || balanceEnd == null ? null : balanceEnd - balanceStart,
        },
      }
    })
    return { user_id: user.id, username: user.username, display_name: user.display_name, role: user.role, active_session: open ?? null, sessions: mine.length, hours: mine.reduce((sum, row) => sum + (new Date(row.checked_out_at ?? now.toISOString()).getTime() - new Date(row.checked_in_at).getTime()) / 3_600_000, 0), transaction_count: txs.length, approved_count: paid.length, transaction_amount: txs.reduce((sum, row) => sum + Number(row.amount ?? 0), 0), approved_amount: paid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0), sms_count: sms.length, wallets: [...wallets], session_reports: sessionReports }
  })
  return c.json({ from, to, wallet, users: stats, sessions })
})

reportsRoutes.post('/attendance/check-in', requireAuth, async (c) => {
  const actor = c.get('actor')
  const body = await c.req.json().catch(() => null)
  const targetId = typeof body?.user_id === 'string' ? body.user_id : actor.sub
  if (targetId !== actor.sub && !ADMIN_ROLES.has(actor.role)) return c.json({ error: 'attendance_scope_denied' }, 403)
  const wallet = String(body?.wallet_number ?? '').replace(/\D/g, '') || null
  const existing = await db.from('staff_attendance_sessions').select('id').eq('user_id', targetId).is('checked_out_at', null).maybeSingle()
  if (existing.data) return c.json({ error: 'already_checked_in' }, 409)
  const { data, error } = await db.from('staff_attendance_sessions').insert({ user_id: targetId, wallet_number: wallet, note: typeof body?.note === 'string' ? body.note.slice(0, 300) : null }).select().single()
  if (error) return c.json({ error: 'attendance_check_in_failed', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'staff.attendance_check_in', entity: 'staff_attendance_sessions', entity_id: data.id, after: { user_id: targetId, wallet_number: wallet } })
  const { data: target } = await db.from('panel_users').select('username, display_name, role').eq('id', targetId).maybeSingle()
  const telegram = await sendTelegramAlert('staff_checkin_report', [
    '🟢 <b>Agent check-in report</b>',
    `الموظف / Agent: <b>${String(target?.display_name || target?.username || targetId).replace(/[<>&]/g, '')}</b>`,
    `الدور / Role: <b>${String(target?.role ?? '—').replace(/[<>&]/g, '')}</b>`,
    `اعتماد الموظف / Employee approval: <b>Checked in</b>`,
    `الوقت / Time: <code>${new Date(data.checked_in_at).toISOString()}</code>`,
    `المحفظة / Wallet: <code>${String(wallet ?? '—').replace(/[<>&]/g, '')}</code>`,
  ].join('\n'))
  return c.json({ ok: true, session: data, telegram: { sent: telegram.sent, error: telegram.error } })
})

reportsRoutes.post('/attendance/check-out', requireAuth, async (c) => {
  const actor = c.get('actor')
  const body = await c.req.json().catch(() => null)
  const targetId = typeof body?.user_id === 'string' ? body.user_id : actor.sub
  if (targetId !== actor.sub && !ADMIN_ROLES.has(actor.role)) return c.json({ error: 'attendance_scope_denied' }, 403)
  const { data: open } = await db.from('staff_attendance_sessions').select('id, checked_in_at, wallet_number').eq('user_id', targetId).is('checked_out_at', null).order('checked_in_at', { ascending: false }).limit(1).maybeSingle()
  if (!open) return c.json({ error: 'not_checked_in' }, 409)
  const { data, error } = await db.from('staff_attendance_sessions').update({ checked_out_at: new Date().toISOString() }).eq('id', open.id).is('checked_out_at', null).select().single()
  if (error) return c.json({ error: 'attendance_check_out_failed', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'staff.attendance_check_out', entity: 'staff_attendance_sessions', entity_id: open.id, after: { user_id: targetId } })
  const checkedInAt = new Date(open.checked_in_at)
  const checkedOutAt = new Date(data.checked_out_at)
  const hours = Math.max(0, (checkedOutAt.getTime() - checkedInAt.getTime()) / 3_600_000)
  const telegram = await sendTelegramAlert('staff_checkout_report', [
    '✅ <b>Agent checkout report</b>',
    `الموظف / Agent: <b>${String(actor.username).replace(/[<>&]/g, '')}</b>`,
    `الحالة / Approval: <b>Employee approved checkout</b>`,
    `دخول / Check-in: <code>${checkedInAt.toISOString()}</code>`,
    `خروج / Check-out: <code>${checkedOutAt.toISOString()}</code>`,
    `الساعات / Hours: <b>${hours.toFixed(2)}</b>`,
    `المحفظة / Wallet: <code>${String(data.wallet_number ?? '—').replace(/[<>&]/g, '')}</code>`,
  ].join('\n'))
  return c.json({ ok: true, session: data, telegram: { sent: telegram.sent, error: telegram.error } })
})
