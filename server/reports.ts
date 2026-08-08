import { Hono } from 'hono'
import { db } from './db.js'
import { requireAnyPerm, requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const reportsRoutes = new Hono<AuthEnv>()
reportsRoutes.use('*', requireAuth)

const DEPOSIT_STATUSES = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'EXPIRED_LOCAL', 'UNDERPAID']
const PAYOUT_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'PAID', 'EXPIRED', 'EXPIRED_LOCAL', 'UNDERPAID']
type Tx = { amount: number | null; status: string | null; merchant: string | null; sub_merchant: string | null; master_merchant: string | null; payment_method: string | null; gateway: string | null; first_seen_at: string | null }
type Payout = { amount: number | null; status: string | null; merchant: string | null; first_seen_at: string | null }

function params(c: any) {
  const from = c.req.query('from')?.trim() || null
  const to = c.req.query('to')?.trim() || null
  return { from, to }
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
  const { from, to } = params(c)
  let deposits = db.from('maven_transactions').select('amount, status, merchant, sub_merchant, master_merchant, payment_method, gateway, first_seen_at').order('first_seen_at', { ascending: true, nullsFirst: false })
  let payouts = db.from('maven_payout_transactions').select('amount, status, merchant, first_seen_at').order('first_seen_at', { ascending: true, nullsFirst: false })
  if (from) { deposits = deposits.gte('first_seen_at', `${from}T00:00:00Z`); payouts = payouts.gte('first_seen_at', `${from}T00:00:00Z`) }
  if (to) { deposits = deposits.lte('first_seen_at', `${to}T23:59:59Z`); payouts = payouts.lte('first_seen_at', `${to}T23:59:59Z`) }
  const [depRows, payoutRows] = await Promise.all([fetchAll<Tx>(deposits), fetchAll<Payout>(payouts)])
  const empty = (statuses: string[]) => Object.fromEntries(statuses.map((status) => [status, { count: 0, amount: 0 }]))
  const depositStatuses = empty(DEPOSIT_STATUSES)
  const payoutStatuses = empty(PAYOUT_STATUSES)
  const byMaster = new Map<string, { master: string; count: number; amount: number }>()
  const byMethod = new Map<string, { method: string; master: string; count: number; amount: number }>()
  const daily = new Map<string, { date: string; deposits: number; payouts: number; count: number }>()
  let includesPayFuture = false
  let ngpayPaid = 0
  let unassigned = { count: 0, amount: 0 }
  for (const row of depRows) {
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
  return { from, to, hero, unassigned, depositStatuses, payoutStatuses, byMaster: [...byMaster.values()].sort((a, b) => b.amount - a.amount), byMethod: [...byMethod.values()].sort((a, b) => b.amount - a.amount), daily: [...daily.values()].sort((a, b) => b.date.localeCompare(a.date)), includesPayFuture }
}
const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`

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
