import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const paymentMethodRoutes = new Hono<AuthEnv>()
paymentMethodRoutes.use('*', requireAuth)

const methodColumns = 'id, method_code, method_name, channel_type, is_active, sort_order, created_at'
const accountColumns = 'id, payment_method_id, payment_pool_id, account_number, account_name, iban, bank_name, currency, country_code, device_name, label, is_active, current_balance, balance_updated_at, created_at'
const poolColumns = 'id, master_merchant_id, pool_name, pool_code, is_active, notes, created_at'
const countryColumns = 'id, payment_method_id, country_code, currency_code, is_active, created_at, updated_at'
const countryMerchantColumns = 'id, method_country_id, merchant_hierarchy_id, is_active, created_at, updated_at'

function text(value: unknown, max = 120): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

paymentMethodRoutes.get('/', requirePerm('payment_methods', 'can_view'), async (c) => {
  const [methods, accounts, pools, poolMembers, hierarchy, masters, methodCountries, countryMerchants, wallets] = await Promise.all([
    db.from('payment_methods').select(methodColumns).order('sort_order').order('method_name'),
    db.from('payment_accounts').select(accountColumns).order('created_at'),
    db.from('payment_pools').select(poolColumns).order('pool_name'),
    db.from('payment_pool_merchants').select('id, payment_pool_id, merchant_hierarchy_id, is_active'),
    db.from('merchants_hierarchy').select('id, name, payin_commission_pct'),
    db.from('master_merchants').select('id, name, code'),
    db.from('payment_method_countries').select(countryColumns).order('country_code'),
    db.from('payment_method_country_merchants').select(countryMerchantColumns).order('created_at'),
    db.from('wallet_device_map').select('to_account_number, provider, device, merchant').order('to_account_number'),
  ])
  const firstError = methods.error ?? accounts.error ?? pools.error ?? poolMembers.error ?? hierarchy.error ?? masters.error ?? methodCountries.error ?? countryMerchants.error ?? wallets.error
  if (firstError) return c.json({ error: 'db_error', detail: firstError.message }, 500)
  return c.json({
    methods: methods.data ?? [],
    accounts: accounts.data ?? [],
    pools: pools.data ?? [],
    poolMembers: poolMembers.data ?? [],
    hierarchy: hierarchy.data ?? [],
    masters: masters.data ?? [],
    methodCountries: methodCountries.data ?? [],
    countryMerchants: countryMerchants.data ?? [],
    wallets: wallets.data ?? [],
  })
})

paymentMethodRoutes.post('/generate', requirePerm('payment_methods', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const method_code = text(body?.method_code, 60)?.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  const method_name = text(body?.method_name)
  const channel_type = text(body?.channel_type, 60)
  const country_code = text(body?.country_code, 2)?.toUpperCase()
  const currency_code = text(body?.currency_code, 3)?.toUpperCase()
  const merchants = Array.isArray(body?.merchant_hierarchy_ids)
    ? [...new Set(body.merchant_hierarchy_ids.map(Number).filter(Number.isInteger))] as number[]
    : []
  if (!method_code || !method_name || !channel_type || !country_code?.match(/^[A-Z]{2}$/) || !currency_code?.match(/^[A-Z]{3}$/)) {
    return c.json({ error: 'invalid_method_generator' }, 400)
  }

  const { data: method, error: methodError } = await db.from('payment_methods').insert({
    method_code, method_name, channel_type, is_active: body?.is_active !== false,
    sort_order: Number.isFinite(Number(body?.sort_order)) ? Number(body.sort_order) : 999,
  }).select(methodColumns).single()
  if (methodError) return c.json({ error: 'method_create_failed', detail: methodError.message }, 400)

  const rollback = async (detail: string) => {
    await db.from('payment_methods').delete().eq('id', method.id)
    return c.json({ error: 'generator_rolled_back', detail }, 400)
  }

  const { data: country, error: countryError } = await db.from('payment_method_countries').insert({
    payment_method_id: method.id, country_code, currency_code, is_active: true,
  }).select(countryColumns).single()
  if (countryError) return rollback(countryError.message)

  if (merchants.length) {
    const { error } = await db.from('payment_method_country_merchants').insert(
      merchants.map((merchant_hierarchy_id) => ({ method_country_id: country.id, merchant_hierarchy_id, is_active: true })),
    )
    if (error) return rollback(error.message)
  }

  const account_number = text(body?.account_number, 100)
  let account = null
  if (account_number) {
    const result = await db.from('payment_accounts').insert({
      payment_method_id: method.id, account_number, account_name: text(body?.account_name),
      bank_name: text(body?.bank_name), device_name: text(body?.device_name, 80), label: text(body?.label),
      currency: currency_code, country_code, is_active: true,
    }).select(accountColumns).single()
    if (result.error) return rollback(result.error.message)
    account = result.data
  }

  const actor = c.get('actor')
  await db.from('audit_log').insert({
    actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username,
    action: 'payment_method.generated', entity: 'payment_methods', entity_id: method.id,
    after: { method_code, method_name, channel_type, country_code, currency_code, merchant_hierarchy_ids: merchants, account_created: Boolean(account) },
  })
  return c.json({ method, country, merchant_assignments: merchants.length, account }, 201)
})

paymentMethodRoutes.post('/countries', requirePerm('payment_methods', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const payment_method_id = text(body?.payment_method_id, 60)
  const country_code = text(body?.country_code, 2)?.toUpperCase()
  const currency_code = text(body?.currency_code, 3)?.toUpperCase()
  if (!payment_method_id || !country_code?.match(/^[A-Z]{2}$/) || !currency_code?.match(/^[A-Z]{3}$/)) return c.json({ error: 'invalid_country_method' }, 400)
  const { data, error } = await db.from('payment_method_countries').upsert({
    payment_method_id, country_code, currency_code, is_active: true, updated_at: new Date().toISOString(),
  }, { onConflict: 'payment_method_id,country_code,currency_code' }).select(countryColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ countryMethod: data }, 201)
})

paymentMethodRoutes.patch('/countries/:id', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
  const { data, error } = await db.from('payment_method_countries').update({ is_active: body.is_active, updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id')).select(countryColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ countryMethod: data })
})

paymentMethodRoutes.post('/countries/:id/merchants', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const merchant_hierarchy_id = Number(body?.merchant_hierarchy_id)
  if (!Number.isInteger(merchant_hierarchy_id)) return c.json({ error: 'invalid_merchant_hierarchy_id' }, 400)
  const { data, error } = await db.from('payment_method_country_merchants').upsert({
    method_country_id: c.req.param('id'), merchant_hierarchy_id, is_active: true, updated_at: new Date().toISOString(),
  }, { onConflict: 'method_country_id,merchant_hierarchy_id' }).select(countryMerchantColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ assignment: data }, 201)
})

paymentMethodRoutes.patch('/countries/merchants/:id', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
  const { data, error } = await db.from('payment_method_country_merchants').update({ is_active: body.is_active, updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id')).select(countryMerchantColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ assignment: data })
})

// --- Payment pools (a pool belongs to one master merchant but can be shared
// by several sub-merchants; accounts may have no pool yet → NULL) ---

paymentMethodRoutes.post('/pools', requirePerm('payment_methods', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const pool_name = text(body?.pool_name)
  const pool_code = text(body?.pool_code, 60)?.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  const master_merchant_id = text(body?.master_merchant_id, 60)
  if (!pool_name || !pool_code || !master_merchant_id) return c.json({ error: 'invalid_pool' }, 400)
  const { data, error } = await db.from('payment_pools').insert({
    pool_name, pool_code, master_merchant_id, is_active: body?.is_active !== false, notes: text(body?.notes, 500),
  }).select(poolColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ pool: data }, 201)
})

paymentMethodRoutes.post('/pools/:id/merchants', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const merchant_hierarchy_id = Number(body?.merchant_hierarchy_id)
  if (!Number.isInteger(merchant_hierarchy_id)) return c.json({ error: 'invalid_merchant_hierarchy_id' }, 400)
  const { data, error } = await db.from('payment_pool_merchants').upsert(
    { payment_pool_id: c.req.param('id'), merchant_hierarchy_id, is_active: true },
    { onConflict: 'payment_pool_id,merchant_hierarchy_id' },
  ).select('id, payment_pool_id, merchant_hierarchy_id, is_active').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ member: data }, 201)
})

paymentMethodRoutes.patch('/pools/members/:id', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
  const { data, error } = await db.from('payment_pool_merchants').update({ is_active: body.is_active })
    .eq('id', c.req.param('id')).select('id, is_active').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ member: data })
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
  if (body?.payment_pool_id !== undefined) {
    // null clears the pool; otherwise must be a UUID of an existing pool
    if (body.payment_pool_id === null) update.payment_pool_id = null
    else if (typeof body.payment_pool_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.payment_pool_id)) update.payment_pool_id = body.payment_pool_id
    else return c.json({ error: 'invalid_payment_pool_id' }, 400)
  }
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_accounts').update(update).eq('id', c.req.param('id')).select(accountColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ account: data })
})
