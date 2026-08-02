import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const paymentMethodRoutes = new Hono<AuthEnv>()
paymentMethodRoutes.use('*', requireAuth)

const methodColumns = 'id, method_code, method_name, channel_type, is_active, sort_order, created_at'
const accountColumns = 'id, payment_method_id, account_number, account_name, iban, bank_name, currency, country_code, device_name, label, is_active, created_at'

function text(value: unknown, max = 120): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

paymentMethodRoutes.get('/', requirePerm('payment_methods', 'can_view'), async (c) => {
  const [methods, accounts] = await Promise.all([
    db.from('payment_methods').select(methodColumns).order('sort_order').order('method_name'),
    db.from('payment_accounts').select(accountColumns).order('created_at'),
  ])
  if (methods.error || accounts.error) return c.json({ error: 'db_error', detail: methods.error?.message ?? accounts.error?.message }, 500)
  return c.json({ methods: methods.data ?? [], accounts: accounts.data ?? [] })
})

paymentMethodRoutes.post('/', requirePerm('payment_methods', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const method_code = text(body?.method_code, 60)?.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  const method_name = text(body?.method_name)
  const channel_type = text(body?.channel_type, 60)
  if (!method_code || !method_name || !channel_type) return c.json({ error: 'invalid_method' }, 400)
  const { data, error } = await db.from('payment_methods').insert({
    method_code, method_name, channel_type, is_active: body?.is_active !== false,
    sort_order: Number.isFinite(Number(body?.sort_order)) ? Number(body.sort_order) : 999,
  }).select(methodColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ method: data }, 201)
})

paymentMethodRoutes.patch('/:id', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const update: Record<string, unknown> = {}
  for (const key of ['method_name', 'channel_type'] as const) {
    if (body?.[key] !== undefined) {
      const value = text(body[key])
      if (!value) return c.json({ error: `invalid_${key}` }, 400)
      update[key] = value
    }
  }
  if (body?.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
    update.is_active = body.is_active
  }
  if (body?.sort_order !== undefined) {
    if (!Number.isFinite(Number(body.sort_order))) return c.json({ error: 'invalid_sort_order' }, 400)
    update.sort_order = Number(body.sort_order)
  }
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_methods').update(update).eq('id', c.req.param('id')).select(methodColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ method: data })
})

paymentMethodRoutes.post('/:id/accounts', requirePerm('payment_methods', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const account_number = text(body?.account_number, 100)
  if (!account_number) return c.json({ error: 'invalid_account_number' }, 400)
  const { data, error } = await db.from('payment_accounts').insert({
    payment_method_id: c.req.param('id'), account_number,
    account_name: text(body?.account_name), iban: text(body?.iban, 120), bank_name: text(body?.bank_name),
    currency: text(body?.currency, 10) ?? 'EGP', country_code: text(body?.country_code, 4) ?? 'EG',
    device_name: text(body?.device_name, 80), label: text(body?.label), is_active: body?.is_active !== false,
  }).select(accountColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ account: data }, 201)
})

paymentMethodRoutes.patch('/accounts/:id', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const update: Record<string, unknown> = {}
  for (const key of ['account_number', 'account_name', 'iban', 'bank_name', 'currency', 'country_code', 'device_name', 'label'] as const) {
    if (body?.[key] !== undefined) {
      const value = text(body[key], key === 'account_number' ? 100 : 120)
      if (key === 'account_number' && !value) return c.json({ error: 'invalid_account_number' }, 400)
      update[key] = value
    }
  }
  if (body?.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
    update.is_active = body.is_active
  }
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_accounts').update(update).eq('id', c.req.param('id')).select(accountColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ account: data })
})
