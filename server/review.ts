import { Hono } from 'hono'
import { db } from './db.js'
import { requireAnyPerm, requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Review — one screen over both decision logs (deposit_decision_log +
// payout_decision_log). Its job is closing the transparency loop: any
// decision recorded with executed_on_provider=false still needs a human
// to actually perform it on the provider portal, and this list is where
// that follow-up lives.

export const reviewRoutes = new Hono<AuthEnv>()
reviewRoutes.use('*', requireAuth)

interface ReviewRow {
  kind: 'deposit' | 'payout'
  id: number
  ref: string | null
  provider_id: number | null
  decision: string | null
  actor_name: string | null
  note: string | null
  proof_url: string | null
  db_status_before: string | null
  executed_on_provider: boolean | null
  created_at: string | null
}

reviewRoutes.get('/', requireAnyPerm(['review', 'audit_log', 'audit-logs'], 'can_view'), async (c) => {
  const pendingOnly = c.req.query('pending_provider') === '1'
  let deposits = db
    .from('deposit_decision_log')
    .select('id, tx_id, ontarget_ref, decision, actor_name, reason, db_status_before, executed_on_provider, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  let payouts = db
    .from('payout_decision_log')
    .select('id, maven_id, ontarget_ref, decision, actor_name, proof_url, remark, db_status_before, executed_on_provider, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (pendingOnly) {
    deposits = deposits.eq('executed_on_provider', false)
    payouts = payouts.eq('executed_on_provider', false)
  }
  const [dep, pay] = await Promise.all([deposits, payouts])
  if (dep.error || pay.error) {
    return c.json({ error: 'db_error', detail: dep.error?.message ?? pay.error?.message }, 500)
  }
  const rows: ReviewRow[] = [
    ...(dep.data ?? []).map((r) => ({
      kind: 'deposit' as const,
      id: r.id,
      ref: r.ontarget_ref,
      provider_id: r.tx_id,
      decision: r.decision,
      actor_name: r.actor_name,
      note: r.reason,
      proof_url: null,
      db_status_before: r.db_status_before,
      executed_on_provider: r.executed_on_provider,
      created_at: r.created_at,
    })),
    ...(pay.data ?? []).map((r) => ({
      kind: 'payout' as const,
      id: r.id,
      ref: r.ontarget_ref,
      provider_id: r.maven_id,
      decision: r.decision,
      actor_name: r.actor_name,
      note: r.remark,
      proof_url: r.proof_url,
      db_status_before: r.db_status_before,
      executed_on_provider: r.executed_on_provider,
      created_at: r.created_at,
    })),
  ].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const pendingProvider = rows.filter((r) => r.executed_on_provider === false).length
  return c.json({ rows, pendingProvider })
})
