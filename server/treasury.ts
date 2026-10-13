import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Treasury currency balances, all derived from V2 tables:
//   Available = active receiving-wallet balances (EGP) / latest Binance USDT value
//   Pending   = deposits still PENDING
//   Held      = PAID deposits blocked from settlement
//   Reserved  = payouts still PENDING
//   Released  = already settled to merchants (merchant_settlements)
export const treasuryRoutes = new Hono<AuthEnv>()
treasuryRoutes.use('*', requireAuth)

const sum = (rows: Array<Record<string, unknown>> | null | undefined, key: string) => (rows ?? []).reduce((a, r) => a + Number(r[key] ?? 0), 0)

treasuryRoutes.get('/balances', requireAnyPerm(['treasury', 'wallets', 'dashboard'], 'can_view'), async (c) => {
  const [wallets, pending, held, payouts, settled, binance, flowIn, flowOut] = await Promise.all([
    db.from('payment_accounts').select('current_balance, currency').eq('is_active', true).limit(5000),
    db.from('maven_transactions').select('amount, currency').eq('status', 'PENDING').limit(50000),
    db.from('maven_transactions').select('amount, currency').eq('status', 'PAID').eq('settlement_blocked', true).limit(50000),
    db.from('maven_payout_transactions').select('amount').eq('status', 'PENDING').limit(50000),
    db.from('merchant_settlements').select('already_settled_egp, already_settled_usdt').limit(50000),
    db.from('binance_account_balances').select('usdt_value, available_balance, measured_at').order('measured_at', { ascending: false }).limit(1),
    db.from('maven_transactions').select('amount').eq('status', 'PAID').gte('first_seen_at', new Date(Date.now() - 24 * 3600_000).toISOString()).limit(50000),
    db.from('maven_payout_transactions').select('amount').eq('status', 'PAID').gte('created_utc', new Date(Date.now() - 24 * 3600_000).toISOString()).limit(50000),
  ])
  const by = (rows: any[] | null | undefined, cur: string) => (rows ?? []).filter((r) => (r.currency ?? 'EGP') === cur)
  const egp = {
    currency: 'EGP',
    available: sum(by(wallets.data, 'EGP').map((r) => ({ v: r.current_balance })), 'v'),
    pending: sum(by(pending.data, 'EGP'), 'amount'),
    held: sum(by(held.data, 'EGP'), 'amount'),
    reserved: sum(payouts.data, 'amount'),
    released: sum(settled.data, 'already_settled_egp'),
  }
  const b = binance.data?.[0] as any
  const usdt = {
    currency: 'USDT',
    available: Number(b?.available_balance ?? b?.usdt_value ?? 0),
    pending: 0, held: 0, reserved: 0,
    released: sum(settled.data, 'already_settled_usdt'),
  }
  return c.json({
    generatedAt: new Date().toISOString(),
    balances: [egp, usdt],
    flow24h: { inflowEgp: sum(flowIn.data, 'amount'), inflows: flowIn.data?.length ?? 0, outflows: flowOut.data?.length ?? 0, outflowEgp: sum(flowOut.data, 'amount') },
    binanceAt: b?.measured_at ?? null,
    errors: [wallets, pending, held, payouts, settled, binance].map((r) => r.error?.message).filter(Boolean),
  })
})
