import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const ticketRoutes = new Hono<AuthEnv>()
ticketRoutes.use('*', requireAuth)
ticketRoutes.use('*', requireAnyPerm(['support', 'complaints'], 'can_view'))

ticketRoutes.get('/', async (c) => {
  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit')) || 100, 200)
  let q = db.from('support_tickets').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(limit)
  if (status && ['open','in_progress','resolved','closed'].includes(status)) q = q.eq('ticket_status', status)
  const { data, count, error } = await q
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0 })
})

ticketRoutes.patch('/:id/status', async (c) => {
  const actor = c.get('actor'); const id = Number(c.req.param('id')); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const status = String(body?.status ?? '')
  if (!Number.isInteger(id) || !['open','in_progress','resolved','closed'].includes(status)) return c.json({ error: 'bad_request' }, 400)
  const now = new Date().toISOString()
  const patch = { ticket_status: status, updated_by: actor.username, updated_at: now, status_changed_at: now }
  const { data, error } = await db.from('support_tickets').update(patch).eq('id', id).select().maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'ticket.status_changed', entity: 'support_tickets', entity_id: String(id), after: { status } })
  return c.json({ ok: true, ticket: data })
})
