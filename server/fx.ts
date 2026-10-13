import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// FX dashboard feed. Rates are real: USD cross rates from open.er-api.com
// (updated daily upstream) and USDT/EGP from Binance P2P public adverts.
// Each pair is snapshotted into exchange_rates at most once per hour so the
// change column compares against our own stored history, never a made-up value.

export const fxRoutes = new Hono<AuthEnv>()
fxRoutes.use('*', requireAuth)

const CURRENCIES = ['EGP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR'] as const
const CACHE_MS = 5 * 60_000
let cache: { at: number; body: unknown } | null = null

function cairoToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

async function fetchUsdRates(): Promise<{ rates: Record<string, number>; updated: string | null } | null> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const j = await res.json() as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string }
    if (j.result !== 'success' || !j.rates) return null
    return { rates: j.rates, updated: j.time_last_update_utc ?? null }
  } catch { return null }
}

async function p2pQuote(tradeType: 'BUY' | 'SELL'): Promise<number | null> {
  try {
    const res = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (OnTarget panel)' }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ asset: 'USDT', fiat: 'EGP', tradeType, page: 1, rows: 5, publisherType: null, payTypes: [] }),
    })
    if (!res.ok) return null
    const j = await res.json() as { data?: Array<{ adv?: { price?: string } }> }
    const prices = (j.data ?? []).map((a) => Number(a.adv?.price)).filter((n) => Number.isFinite(n) && n > 0)
    return prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null
  } catch { return null }
}

fxRoutes.get('/rates', requireAnyPerm(['dashboard', 'merchants', 'reports', 'treasury'], 'can_view'), async (c) => {
  if (cache && Date.now() - cache.at < CACHE_MS) return c.json(cache.body)
  const [usd, buy, sell] = await Promise.all([fetchUsdRates(), p2pQuote('BUY'), p2pQuote('SELL')])

  const pairs: Array<{ pair: string; rate: number }> = []
  if (usd) for (const cur of CURRENCIES) if (usd.rates[cur]) pairs.push({ pair: `USD/${cur}`, rate: usd.rates[cur] })
  if (buy && sell) pairs.push({ pair: 'USDT/EGP', rate: (buy + sell) / 2 })

  // Hourly snapshots + 24h change from our own history.
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const names = pairs.map((p) => p.pair)
  const { data: hist } = names.length
    ? await db.from('exchange_rates').select('currency_pair, rate, fetched_at').in('currency_pair', names).gte('fetched_at', since).order('fetched_at')
    : { data: [] as Array<{ currency_pair: string; rate: number; fetched_at: string }> }
  const first = new Map<string, number>(); const last = new Map<string, number>()
  for (const h of hist ?? []) { if (!first.has(h.currency_pair)) first.set(h.currency_pair, Number(h.rate)); last.set(h.currency_pair, new Date(h.fetched_at).getTime()) }
  const toInsert = pairs.filter((p) => Date.now() - (last.get(p.pair) ?? 0) > 3_600_000)
  if (toInsert.length) await db.from('exchange_rates').insert(toInsert.map((p) => ({ currency_pair: p.pair, rate: p.rate })))

  const rates = pairs.map((p) => {
    const base = first.get(p.pair)
    return { pair: p.pair, rate: p.rate, change: base ? p.rate - base : null, change_pct: base ? ((p.rate - base) / base) * 100 : null }
  })

  // Real operating KPIs (Cairo day).
  const today = cairoToday()
  const [daily, pending, settle, clients] = await Promise.all([
    db.from('v_merchant_daily_cairo').select('paid_n, paid_amt, declined_n, other_n, commission').eq('day_cairo', today),
    db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    db.from('merchant_settlements').select('balance_due_egp, status').neq('status', 'settled'),
    db.from('crm_clients').select('id', { count: 'exact', head: true }).gte('created_at', `${today}T00:00:00+03:00`),
  ])
  const sum = (k: 'paid_n' | 'paid_amt' | 'declined_n' | 'other_n' | 'commission') => (daily.data ?? []).reduce((a, r) => a + Number((r as Record<string, unknown>)[k] ?? 0), 0)
  const paidN = sum('paid_n'); const declinedN = sum('declined_n')
  const body = {
    rates,
    usdt: buy && sell ? { buy, sell, spread: Math.abs(sell - buy) } : null,
    source_updated: usd?.updated ?? null,
    kpis: {
      volume_today: sum('paid_amt'),
      paid_today: paidN,
      declined_today: declinedN,
      transactions_today: paidN + declinedN + sum('other_n'),
      success_rate: paidN + declinedN > 0 ? (paidN / (paidN + declinedN)) * 100 : null,
      pending_now: pending.count ?? 0,
      commission_today: sum('commission'),
      settlements_due: (settle.data ?? []).reduce((a, r) => a + Number(r.balance_due_egp ?? 0), 0),
      settlements_open: (settle.data ?? []).length,
      new_clients_today: clients.count ?? 0,
    },
    generated_at: new Date().toISOString(),
  }
  cache = { at: Date.now(), body }
  return c.json(body)
})
