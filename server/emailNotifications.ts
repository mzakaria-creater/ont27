import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const emailNotificationRoutes = new Hono<AuthEnv>()
emailNotificationRoutes.use('*', requireAuth)

const ADMIN_ROLES = new Set(['super_admin', 'owner', 'admin', 'operations_admin'])
const SCOPE_TYPES = new Set(['all', 'merchant', 'country', 'payment_method'])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function canManage(role: string) {
  return ADMIN_ROLES.has(role)
}

emailNotificationRoutes.get('/', async (c) => {
  const actor = c.get('actor')
  if (!canManage(actor.role)) return c.json({ error: 'admin_required' }, 403)

  const [rules, txs] = await Promise.all([
    db.from('approval_email_subscriptions').select('*').order('created_at', { ascending: false }),
    db.from('maven_transactions').select('master_merchant, merchant, country, payment_method, gateway').order('first_seen_at', { ascending: false, nullsFirst: false }).limit(10_000),
  ])
  if (rules.error) return c.json({ error: 'db_error', detail: rules.error.message }, 500)
  if (txs.error) return c.json({ error: 'db_error', detail: txs.error.message }, 500)

  const values = (keys: string[]) => [...new Set((txs.data ?? []).flatMap((row) => keys.map((key) => String((row as Record<string, unknown>)[key] ?? '').trim())).filter(Boolean))].sort()
  return c.json({
    rows: rules.data ?? [],
    options: {
      merchant: values(['master_merchant', 'merchant']),
      country: values(['country']),
      payment_method: values(['payment_method', 'gateway']),
    },
  })
})

emailNotificationRoutes.post('/', async (c) => {
  const actor = c.get('actor')
  if (!canManage(actor.role)) return c.json({ error: 'admin_required' }, 403)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const email = String(body.email ?? '').trim().toLowerCase()
  const scopeType = String(body.scope_type ?? 'all')
  const scopeValue = scopeType === 'all' ? null : String(body.scope_value ?? '').trim()
  const label = String(body.label ?? '').trim().slice(0, 100) || null
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: 'invalid_email' }, 400)
  if (!SCOPE_TYPES.has(scopeType) || (scopeType !== 'all' && !scopeValue)) return c.json({ error: 'invalid_scope' }, 400)

  const { data, error } = await db.from('approval_email_subscriptions').insert({
    email, scope_type: scopeType, scope_value: scopeValue, label,
    active: body.active !== false, created_by: actor.username,
  }).select('*').single()
  if (error) return c.json({ error: error.code === '23505' ? 'assignment_exists' : 'db_error', detail: error.message }, error.code === '23505' ? 409 : 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'approval_email_subscription.created', entity: 'approval_email_subscriptions', entity_id: data.id, after: data })
  return c.json({ ok: true, row: data }, 201)
})

emailNotificationRoutes.patch('/:id', async (c) => {
  const actor = c.get('actor')
  if (!canManage(actor.role)) return c.json({ error: 'admin_required' }, 403)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.active != null) patch.active = Boolean(body.active)
  if (body.label != null) patch.label = String(body.label).trim().slice(0, 100) || null
  const { data, error } = await db.from('approval_email_subscriptions').update(patch).eq('id', id).select('*').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'approval_email_subscription.updated', entity: 'approval_email_subscriptions', entity_id: id, after: patch })
  return c.json({ ok: true, row: data })
})

emailNotificationRoutes.delete('/:id', async (c) => {
  const actor = c.get('actor')
  if (!canManage(actor.role)) return c.json({ error: 'admin_required' }, 403)
  const id = c.req.param('id')
  const { error } = await db.from('approval_email_subscriptions').delete().eq('id', id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'approval_email_subscription.deleted', entity: 'approval_email_subscriptions', entity_id: id })
  return c.json({ ok: true })
})
