import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// الشكاوى — tx_complaints + complaint_* RPCs live on the OLD prod DB.

export const complaintRoutes = new Hono<AuthEnv>()

complaintRoutes.use('*', requireAuth)

const ALLOWED = new Set(['owner', 'admin', 'super_admin', 'operator', 'operations_admin'])
complaintRoutes.use('*', async (c, next) => {
  if (!ALLOWED.has(c.get('actor').role)) return c.json({ error: 'forbidden' }, 403)
  await next()
})

const audit = (actor: { sub: string; username: string }, action: string, entityId: string, after: Record<string, unknown>) =>
  db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action,
    entity: 'tx_complaints',
    entity_id: entityId,
    after,
  })

complaintRoutes.get('/', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const status = c.req.query('status')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  let query = old
    .from('tx_complaints')
    .select('id, tx_id, customer_phone, amount, note, status, finding, created_at, resolved_at, admin_note', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (status) query = query.eq('status', status)
  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0 })
})

complaintRoutes.post('/log', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const txId = body?.tx_id ? Number(body.tx_id) : null
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : null
  const amount = body?.amount != null ? Number(body.amount) : null
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  if (!phone && !txId) return c.json({ error: 'bad_request' }, 400)
  const { data, error } = await old.rpc('complaint_log', {
    p_tx_id: txId,
    p_phone: phone,
    p_amount: amount,
    p_note: note,
  })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  await audit(c.get('actor'), 'complaint.log', String(txId ?? phone), { phone, amount, note })
  return c.json({ ok: true, result: data })
})

complaintRoutes.post('/investigate', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const { data, error } = await old.rpc('complaint_investigate', {
    p_tx_id: body?.tx_id ? Number(body.tx_id) : null,
    p_phone: typeof body?.phone === 'string' ? body.phone.trim() : null,
    p_amount: body?.amount != null ? Number(body.amount) : null,
  })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  return c.json({ ok: true, result: data })
})

const DECISIONS: Record<string, string> = {
  approve: 'complaint_approve',
  decline: 'complaint_decline',
  close: 'complaint_close',
}

complaintRoutes.post('/:id/:decision', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const id = Number(c.req.param('id'))
  const decision = c.req.param('decision')
  const rpcName = DECISIONS[decision]
  if (!rpcName || !Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400)
  const body = await c.req.json().catch(() => null)
  const txId = Number(body?.tx_id)
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  if (!Number.isInteger(txId)) return c.json({ error: 'bad_tx_id' }, 400)

  const args: Record<string, unknown> = { p_tx_id: txId, p_complaint_id: id, p_admin_note: note }
  if (decision === 'approve') args.p_target_status = 'PAID'
  const { data, error } = await old.rpc(rpcName, args)
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  await audit(c.get('actor'), `complaint.${decision}`, String(id), { tx_id: txId, note, result: data })
  return c.json({ ok: true, result: data })
})
