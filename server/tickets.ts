import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const ticketRoutes = new Hono<AuthEnv>()
ticketRoutes.use('*', requireAuth)
ticketRoutes.use('*', requireAnyPerm(['support', 'complaints'], 'can_view'))

ticketRoutes.get('/', async (c) => {
  const actor = c.get('actor')
  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit')) || 100, 200)
  let q = db.from('support_tickets').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(limit)
  if (status && ['open','in_progress','resolved','closed'].includes(status)) q = q.eq('ticket_status', status)
  const canSeeAll = ['owner', 'admin', 'super_admin', 'operations_admin'].includes(actor.role)
  if (!canSeeAll || c.req.query('mine') === '1') q = q.eq('assigned_to', actor.username)
  const { data, count, error } = await q
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0 })
})

ticketRoutes.get('/assignees', async (c) => {
  const { data, error } = await db.from('panel_users').select('id, username, display_name, role, active').eq('active', true).order('username').limit(200)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [] })
})

ticketRoutes.post('/', requirePerm('support', 'can_create'), async (c) => {
  const actor = c.get('actor'); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const subject = typeof body?.subject === 'string' ? body.subject.trim().slice(0, 180) : ''
  if (!subject) return c.json({ error: 'subject_required' }, 400)
  const now = new Date().toISOString()
  const payload = {
    ticket_no: `TKT-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
    subject, description: typeof body?.description === 'string' ? body.description.slice(0, 4000) : null,
    action_requested: typeof body?.action_requested === 'string' ? body.action_requested.slice(0, 1000) : null,
    assigned_to: typeof body?.assigned_to === 'string' ? body.assigned_to.slice(0, 120) : null,
    due_at: typeof body?.due_at === 'string' && body.due_at ? new Date(body.due_at).toISOString() : null,
    priority: ['high','medium','normal','low'].includes(String(body?.priority)) ? body?.priority : 'normal',
    task_type: typeof body?.task_type === 'string' ? body.task_type.slice(0, 40) : 'support',
    ticket_status: 'open', opened_by: actor.username, updated_by: actor.username, created_at: now, updated_at: now,
  }
  const { data, error } = await db.from('support_tickets').insert(payload).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'ticket.created', entity: 'support_tickets', entity_id: String(data.id), after: payload })
  return c.json({ ok: true, ticket: data }, 201)
})

ticketRoutes.patch('/:id', async (c) => {
  const actor = c.get('actor'); const id = Number(c.req.param('id')); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400)
  const existing = await db.from('support_tickets').select('id, assigned_to').eq('id', id).maybeSingle()
  if (existing.error) return c.json({ error: 'db_error', detail: existing.error.message }, 500)
  if (!existing.data) return c.json({ error: 'not_found' }, 404)
  const manager = ['owner', 'admin', 'super_admin', 'operations_admin'].includes(actor.role)
  if (!manager && existing.data.assigned_to !== actor.username) return c.json({ error: 'ticket_not_assigned_to_you' }, 403)
  const patch: Record<string, unknown> = { updated_by: actor.username, updated_at: new Date().toISOString() }
  for (const key of ['subject','description','action_requested','assigned_to','task_type']) if (typeof body?.[key] === 'string') patch[key] = String(body[key]).slice(0, key === 'description' ? 4000 : 1000)
  if (body?.due_at === null || (typeof body?.due_at === 'string' && body.due_at)) patch.due_at = body.due_at ? new Date(String(body.due_at)).toISOString() : null
  if (['high','medium','normal','low'].includes(String(body?.priority))) patch.priority = body?.priority
  if (['open','in_progress','resolved','closed'].includes(String(body?.ticket_status))) { patch.ticket_status = body?.ticket_status; patch.status_changed_at = patch.updated_at }
  const { data, error } = await db.from('support_tickets').update(patch).eq('id', id).select().maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'ticket.updated', entity: 'support_tickets', entity_id: String(id), after: patch })
  return c.json({ ok: true, ticket: data })
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
