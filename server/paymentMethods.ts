import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const paymentMethodRoutes = new Hono<AuthEnv>()
paymentMethodRoutes.use('*', requireAuth)

const methodColumns = 'id, method_code, method_name, name_ar, name_en, icon, channel_type, is_active, sort_order, fee_mode, deposit_fee, withdrawal_fee, min_amount, max_amount, created_at'
const FEE_MODES = new Set(['fixed', 'percent', 'both'])
const accountColumns = 'id, payment_method_id, payment_pool_id, account_number, account_name, iban, bank_name, currency, country_code, device_name, label, is_active, priority, notes, account_type, current_balance, balance_updated_at, created_at'

// Same Cairo-day-boundary and digit-normalization helpers already used by
// server/extras.ts's wallet report — duplicated locally (they are not
// exported there) rather than widening that file's exports for two small
// date/string functions.
const CAIRO_TIME_ZONE = 'Africa/Cairo'
function cairoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAIRO_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function cairoOffset(date: string) {
  const guess = new Date(`${date}T00:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CAIRO_TIME_ZONE, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour) % 24, Number(values.minute))
  const minutes = Math.round((localAsUtc - guess.getTime()) / 60000)
  const sign = minutes >= 0 ? '+' : '-'; const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
function cairoBoundary(date: string) {
  return `${date}T00:00:00${cairoOffset(date)}`
}
function walletDigits(value: unknown) {
  return String(value ?? '').replace(/\D/g, '')
}
const poolColumns = 'id, master_merchant_id, pool_name, pool_code, is_active, notes, rotation_enabled, rotation_interval_minutes, allocation_strategy, next_rotation_at, created_at'
const countryColumns = 'id, payment_method_id, country_code, currency_code, is_active, created_at, updated_at'
const countryMerchantColumns = 'id, method_country_id, merchant_hierarchy_id, is_active, created_at, updated_at'

function text(value: unknown, max = 120): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

paymentMethodRoutes.get('/', requirePerm('payment_methods', 'can_view'), async (c) => {
  const today = cairoToday()
  const [methods, accounts, pools, poolMembers, hierarchy, masters, methodCountries, countryMerchants, wallets, capacities, todayDeposits] = await Promise.all([
    db.from('payment_methods').select(methodColumns).order('sort_order').order('method_name'),
    db.from('payment_accounts').select(accountColumns).order('created_at'),
    db.from('payment_pools').select(poolColumns).order('pool_name'),
    db.from('payment_pool_merchants').select('id, payment_pool_id, merchant_hierarchy_id, is_active'),
    db.from('merchants_hierarchy').select('id, name, payin_commission_pct'),
    db.from('master_merchants').select('id, name, code:mid'),
    db.from('payment_method_countries').select(countryColumns).order('country_code'),
    db.from('payment_method_country_merchants').select(countryMerchantColumns).order('created_at'),
    db.from('wallet_device_map').select('to_account_number, provider, device, merchant').order('to_account_number'),
    // Real per-account daily cap, same table/endpoint the Admin "Wallet
    // capacity" tab already edits (PUT /api/admin/capacity/:accountId) —
    // not duplicated here, just read so this page can show it too.
    db.from('wallet_capacity_limits').select('payment_account_id, daily_limit'),
    // Real daily usage: same deposit-status set and Cairo-day-boundary logic
    // already used by /api/wallet-report, scoped to today only (this page
    // does not need the monthly figure, which is a global constant there).
    db.from('maven_transactions').select('amount, status, receiving_wallet, to_account_number, first_seen_at').gte('first_seen_at', cairoBoundary(today)).limit(20_000),
  ])
  const firstError = methods.error ?? accounts.error ?? pools.error ?? poolMembers.error ?? hierarchy.error ?? masters.error ?? methodCountries.error ?? countryMerchants.error ?? wallets.error ?? capacities.error ?? todayDeposits.error
  if (firstError) return c.json({ error: 'db_error', detail: firstError.message }, 500)

  const dailyUsedByWallet = new Map<string, number>()
  for (const tx of todayDeposits.data ?? []) {
    if (!['PENDING', 'PAID', 'APPROVED', 'SUCCESS', 'COMPLETED'].includes(String(tx.status ?? '').toUpperCase())) continue
    const wallet = walletDigits(tx.receiving_wallet || tx.to_account_number)
    if (!wallet) continue
    dailyUsedByWallet.set(wallet, (dailyUsedByWallet.get(wallet) ?? 0) + Number(tx.amount ?? 0))
  }
  const capacityByAccountId = new Map((capacities.data ?? []).map((row) => [row.payment_account_id, Number(row.daily_limit)]))
  const accountsWithCapacity = (accounts.data ?? []).map((account) => ({
    ...account,
    daily_limit: capacityByAccountId.get(account.id) ?? 10_000,
    daily_used: dailyUsedByWallet.get(walletDigits(account.account_number)) ?? 0,
  }))

  return c.json({
    methods: methods.data ?? [],
    accounts: accountsWithCapacity,
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

paymentMethodRoutes.post('/pools/:id/merchants/bulk', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const merchantIds = Array.isArray(body?.merchant_hierarchy_ids) ? [...new Set(body.merchant_hierarchy_ids.map(Number).filter(Number.isInteger))] : []
  if (!merchantIds.length) return c.json({ error: 'invalid_merchant_hierarchy_ids' }, 400)
  const { data, error } = await db.from('payment_pool_merchants').upsert(
    merchantIds.map((merchant_hierarchy_id) => ({ payment_pool_id: c.req.param('id'), merchant_hierarchy_id, is_active: true })),
    { onConflict: 'payment_pool_id,merchant_hierarchy_id' },
  ).select('id, payment_pool_id, merchant_hierarchy_id, is_active')
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ members: data ?? [] }, 201)
})

paymentMethodRoutes.patch('/pools/:id/rule', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const update: Record<string, unknown> = {}
  if (body?.rotation_enabled !== undefined) {
    if (typeof body.rotation_enabled !== 'boolean') return c.json({ error: 'invalid_rotation_enabled' }, 400)
    update.rotation_enabled = body.rotation_enabled
  }
  if (body?.rotation_interval_minutes !== undefined) {
    const minutes = Number(body.rotation_interval_minutes)
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080) return c.json({ error: 'invalid_rotation_interval' }, 400)
    update.rotation_interval_minutes = minutes
  }
  if (body?.allocation_strategy !== undefined) {
    if (!['next_wallet', 'least_loaded', 'highest_balance'].includes(body.allocation_strategy)) return c.json({ error: 'invalid_allocation_strategy' }, 400)
    update.allocation_strategy = body.allocation_strategy
  }
  if (body?.rotation_enabled === true || body?.next_rotation_at !== undefined) update.next_rotation_at = body?.next_rotation_at ?? new Date(Date.now() + Number(body?.rotation_interval_minutes ?? 60) * 60_000).toISOString()
  if (body?.rotation_enabled === false) update.next_rotation_at = null
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_pools').update(update).eq('id', c.req.param('id')).select(poolColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ pool: data })
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
  const fee_mode = FEE_MODES.has(body?.fee_mode) ? body.fee_mode : 'percent'
  const { data, error } = await db.from('payment_methods').insert({
    method_code, method_name, channel_type, is_active: body?.is_active !== false,
    sort_order: Number.isFinite(Number(body?.sort_order)) ? Number(body.sort_order) : 999,
    name_ar: text(body?.name_ar), name_en: text(body?.name_en), icon: text(body?.icon, 8),
    fee_mode,
    deposit_fee: Number.isFinite(Number(body?.deposit_fee)) ? Number(body.deposit_fee) : 0,
    withdrawal_fee: Number.isFinite(Number(body?.withdrawal_fee)) ? Number(body.withdrawal_fee) : 0,
    min_amount: body?.min_amount != null && Number.isFinite(Number(body.min_amount)) ? Number(body.min_amount) : null,
    max_amount: body?.max_amount != null && Number.isFinite(Number(body.max_amount)) ? Number(body.max_amount) : null,
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
  for (const key of ['name_ar', 'name_en'] as const) {
    if (body?.[key] !== undefined) update[key] = text(body[key])
  }
  if (body?.icon !== undefined) update.icon = text(body.icon, 8)
  if (body?.fee_mode !== undefined) {
    if (!FEE_MODES.has(body.fee_mode)) return c.json({ error: 'invalid_fee_mode' }, 400)
    update.fee_mode = body.fee_mode
  }
  for (const key of ['deposit_fee', 'withdrawal_fee'] as const) {
    if (body?.[key] !== undefined) {
      if (!Number.isFinite(Number(body[key]))) return c.json({ error: `invalid_${key}` }, 400)
      update[key] = Number(body[key])
    }
  }
  for (const key of ['min_amount', 'max_amount'] as const) {
    if (body?.[key] !== undefined) {
      if (body[key] === null) { update[key] = null; continue }
      if (!Number.isFinite(Number(body[key]))) return c.json({ error: `invalid_${key}` }, 400)
      update[key] = Number(body[key])
    }
  }
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_methods').update(update).eq('id', c.req.param('id')).select(methodColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ method: data })
})

const ACCOUNT_TYPES = new Set(['deposit', 'withdrawal', 'both'])

paymentMethodRoutes.post('/:id/accounts', requirePerm('payment_methods', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const account_number = text(body?.account_number, 100)
  if (!account_number) return c.json({ error: 'invalid_account_number' }, 400)
  const priority = Number.isInteger(Number(body?.priority)) ? Number(body.priority) : 1
  const account_type = ACCOUNT_TYPES.has(body?.account_type) ? body.account_type : 'both'
  const { data, error } = await db.from('payment_accounts').insert({
    payment_method_id: c.req.param('id'), account_number,
    account_name: text(body?.account_name), iban: text(body?.iban, 120), bank_name: text(body?.bank_name),
    currency: text(body?.currency, 10) ?? 'EGP', country_code: text(body?.country_code, 4) ?? 'EG',
    device_name: text(body?.device_name, 80), label: text(body?.label), is_active: body?.is_active !== false,
    priority, notes: text(body?.notes, 2000), account_type,
  }).select(accountColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ account: data }, 201)
})

paymentMethodRoutes.patch('/accounts/bulk', requirePerm('payment_methods', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const ids = Array.isArray(body?.account_ids) ? [...new Set(body.account_ids.filter((id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))] as string[] : []
  if (!ids.length) return c.json({ error: 'invalid_account_ids' }, 400)
  const update: Record<string, unknown> = {}
  if (body?.payment_pool_id === null) update.payment_pool_id = null
  else if (body?.payment_pool_id !== undefined) {
    if (typeof body.payment_pool_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.payment_pool_id)) update.payment_pool_id = body.payment_pool_id
    else return c.json({ error: 'invalid_payment_pool_id' }, 400)
  }
  if (body?.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
    update.is_active = body.is_active
  }
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_accounts').update(update).in('id', ids).select(accountColumns)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ accounts: data ?? [] })
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
  if (body?.priority !== undefined) {
    const priority = Number(body.priority)
    if (!Number.isInteger(priority)) return c.json({ error: 'invalid_priority' }, 400)
    update.priority = priority
  }
  if (body?.notes !== undefined) update.notes = text(body.notes, 2000)
  if (body?.account_type !== undefined) {
    if (!ACCOUNT_TYPES.has(body.account_type)) return c.json({ error: 'invalid_account_type' }, 400)
    update.account_type = body.account_type
  }
  if (!Object.keys(update).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('payment_accounts').update(update).eq('id', c.req.param('id')).select(accountColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ account: data })
})
