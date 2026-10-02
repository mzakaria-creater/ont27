import { Hono } from 'hono'
import { db } from './db.js'
import { requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Internal operator dashboard: live gateway/wallet balances, pending
// deposits, and pending withdrawal requests — NOT the public merchant-facing
// payment API in server/gateway.ts (that's a Stripe-style integration
// surface for external merchants; this is a read-only ops view over the
// same real tables every other panel page already uses).

export const gatewayDashboardRoutes = new Hono<AuthEnv>()
gatewayDashboardRoutes.use('*', requireAnyPerm(['wallets', 'deposits', 'payouts'], 'can_view'))

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

gatewayDashboardRoutes.get('/', async (c) => {
  const [accountsRes, deviceRes, depositsRes, withdrawalsRes] = await Promise.all([
    db.from('payment_accounts').select('id, account_number, account_name, label, currency, device_name, is_active, current_balance, balance_updated_at').order('account_number').limit(500),
    db.from('device_status').select('device, sim_slot, online, battery, balance, balance_at, last_seen_at').limit(500),
    // Pending deposits: the same real maven_transactions table Deposits.tsx
    // and Approvals.tsx already read — no separate/mocked source.
    db.from('maven_transactions').select('tx_id, ontarget_ref, amount, currency, sender_name, sender_number, merchant, payment_method, to_account_number, receiving_wallet, first_seen_at').eq('status', 'PENDING').order('first_seen_at', { ascending: false }).limit(200),
    // Pending withdrawal requests: maven_payout_transactions is the real,
    // single withdrawal ledger used system-wide (Payouts.tsx, Approvals.tsx,
    // FinanceOperations, Reports) — linking here to that same table, not a
    // separate/placeholder one.
    db.from('maven_payout_transactions').select('maven_id, ontarget_ref, amount, pay_by, merchant, account_name, mobile_no, first_seen_at').eq('status', 'PENDING').order('first_seen_at', { ascending: false }).limit(200),
  ])
  for (const r of [accountsRes, deviceRes, depositsRes, withdrawalsRes]) if (r.error) return c.json({ error: 'db_error', detail: r.error.message }, 500)

  const deviceByName = new Map((deviceRes.data ?? []).map((d) => [String(d.device ?? ''), d]))
  const balances = (accountsRes.data ?? []).map((a) => {
    const device = a.device_name ? deviceByName.get(String(a.device_name)) : null
    return {
      id: a.id,
      account_number: a.account_number,
      account_name: a.account_name,
      label: a.label,
      currency: a.currency ?? 'EGP',
      device: a.device_name ?? null,
      is_active: Boolean(a.is_active),
      balance: a.current_balance == null ? null : num(a.current_balance),
      balance_updated_at: a.balance_updated_at ?? null,
      device_online: device?.online ?? null,
      device_last_seen_at: device?.last_seen_at ?? null,
    }
  })

  const deposits = (depositsRes.data ?? []).map((r) => ({
    tx_id: r.tx_id,
    ref: r.ontarget_ref ?? String(r.tx_id),
    amount: num(r.amount),
    currency: r.currency ?? 'EGP',
    party: r.sender_name ?? r.sender_number ?? null,
    merchant: r.merchant ?? null,
    method: r.payment_method ?? null,
    wallet: r.to_account_number ?? r.receiving_wallet ?? null,
    created_at: r.first_seen_at,
  }))

  const withdrawals = (withdrawalsRes.data ?? []).map((r) => ({
    maven_id: r.maven_id,
    ref: r.ontarget_ref ?? String(r.maven_id),
    amount: num(r.amount),
    method: r.pay_by ?? null,
    merchant: r.merchant ?? null,
    party: r.account_name ?? r.mobile_no ?? null,
    wallet: r.mobile_no ?? null,
    created_at: r.first_seen_at,
  }))

  const totalBalance = balances.reduce((sum, b) => sum + (b.balance ?? 0), 0)
  const onlineDevices = balances.filter((b) => b.device_online === true).length

  return c.json({
    generated_at: new Date().toISOString(),
    summary: {
      total_balance: totalBalance,
      wallet_count: balances.length,
      online_devices: onlineDevices,
      pending_deposits_count: deposits.length,
      pending_deposits_amount: deposits.reduce((sum, d) => sum + d.amount, 0),
      pending_withdrawals_count: withdrawals.length,
      pending_withdrawals_amount: withdrawals.reduce((sum, w) => sum + w.amount, 0),
    },
    balances,
    pending_deposits: deposits,
    pending_withdrawals: withdrawals,
  })
})
