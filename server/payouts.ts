import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Payouts = maven_payout_transactions. Key column is maven_id (Maven's id);
// ontarget_ref is OUR reference and is what the panel surfaces first.
// Observed statuses: PENDING | APPROVED | DECLINED. Amounts are EGP —
// the table has no currency column (currency lives in maven_raw_row).

export const payoutRoutes = new Hono<AuthEnv>()

payoutRoutes.use('*', requireAuth)

const LIST_COLUMNS =
  'maven_id, guid, ontarget_ref, status, amount, pay_by, merchant, account_name, mobile_no, agent_name, commission, remark, image_url, created_utc, first_seen_at, last_seen_at'

const DECISION_TARGET: Record<string, string> = {
  approve: 'APPROVED',
  decline: 'DECLINED',
}

payoutRoutes.get('/', requirePerm('payouts', 'can_view'), async (c) => {
  const status = c.req.query('status')?.toUpperCase()
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  let query = db
    .from('maven_payout_transactions')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order('maven_id', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [
      `ontarget_ref.ilike.${like}`,
      `mobile_no.ilike.${like}`,
      `account_name.ilike.${like}`,
      `merchant.ilike.${like}`,
      `agent_name.ilike.${like}`,
    ]
    if (/^\d+$/.test(q)) ors.push(`maven_id.eq.${q}`)
    query = query.or(ors.join(','))
  }

  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0, limit, offset })
})

payoutRoutes.get('/:mavenId', requirePerm('payouts', 'can_view'), async (c) => {
  const mavenId = c.req.param('mavenId')
  if (!/^\d+$/.test(mavenId)) return c.json({ error: 'bad_id' }, 400)
  const { data, error } = await db
    .from('maven_payout_transactions')
    .select('*')
    .eq('maven_id', mavenId)
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ payout: data })
})

payoutRoutes.post('/:mavenId/decision', requirePerm('payouts', 'can_approve'), async (c) => {
  const mavenId = c.req.param('mavenId')
  if (!/^\d+$/.test(mavenId)) return c.json({ error: 'bad_id' }, 400)

  const body = await c.req.json().catch(() => null)
  const action = body?.action as string | undefined
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  const target = action ? DECISION_TARGET[action] : undefined
  if (!target) return c.json({ error: 'bad_action' }, 400)

  const { data: before, error: readErr } = await db
    .from('maven_payout_transactions')
    .select('maven_id, status, amount, ontarget_ref, merchant')
    .eq('maven_id', mavenId)
    .maybeSingle()
  if (readErr) return c.json({ error: 'db_error', detail: readErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.status !== 'PENDING') {
    return c.json({ error: 'not_pending', status: before.status }, 409)
  }

  const actor = c.get('actor')
  const nowIso = new Date().toISOString()
  // .eq('status','PENDING') keeps the transition atomic against races.
  const { data: updated, error: updErr } = await db
    .from('maven_payout_transactions')
    .update({ status: target, updated_utc: nowIso, last_seen_at: nowIso })
    .eq('maven_id', mavenId)
    .eq('status', 'PENDING')
    .select('maven_id, status')
  if (updErr) return c.json({ error: 'db_error', detail: updErr.message }, 500)
  if (!updated?.length) return c.json({ error: 'not_pending' }, 409)

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: `payout.${action}`,
    entity: 'maven_payout_transactions',
    entity_id: mavenId,
    before: { status: before.status },
    after: { status: target, note },
  })
  if (auditErr) {
    return c.json({ ok: true, status: target, audit_error: auditErr.message })
  }

  return c.json({ ok: true, status: target })
})
