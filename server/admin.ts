import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import { hashPassword, sha256Hex } from './tokens.js'
import { requireAdminRole, requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const adminRoutes = new Hono<AuthEnv>()
adminRoutes.use('*', requireAuth)
adminRoutes.use('*', async (c, next) => {
  const isOperatorLedger = c.req.method === 'GET' && c.req.path.endsWith('/admin/transactions') && c.get('actor').role === 'operations_admin'
  if (isOperatorLedger) return next()
  return requireAdminRole(c, next)
})

adminRoutes.get('/transactions', requirePerm('transactions', 'can_view'), async (c) => {
  const status = c.req.query('status')?.trim().toUpperCase()
  const q = c.req.query('q')?.trim()
  const from = c.req.query('from')?.trim()
  const to = c.req.query('to')?.trim()
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  let query = db.from('maven_transactions').select('*', { count: 'exact' })
    .order('tx_id', { ascending: false }).range(offset, offset + limit - 1)
  let summaryQuery = db.from('maven_transactions').select('status, amount').limit(10_000)
  if (status) query = query.eq('status', status)
  if (status) summaryQuery = summaryQuery.eq('status', status)
  if (from) query = query.gte('first_seen_at', `${from}T00:00:00Z`)
  if (from) summaryQuery = summaryQuery.gte('first_seen_at', `${from}T00:00:00Z`)
  if (to) query = query.lte('first_seen_at', `${to}T23:59:59.999Z`)
  if (to) summaryQuery = summaryQuery.lte('first_seen_at', `${to}T23:59:59.999Z`)
  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [`ontarget_ref.ilike.${like}`, `merchant_tx_reference.ilike.${like}`, `sender_number.ilike.${like}`, `email.ilike.${like}`]
    if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
    query = query.or(ors.join(','))
    summaryQuery = summaryQuery.or(ors.join(','))
  }
  const [records, summaryRows] = await Promise.all([query, summaryQuery])
  if (records.error || summaryRows.error) return c.json({ error: 'db_error', detail: (records.error ?? summaryRows.error)?.message }, 500)
  const summary = (summaryRows.data ?? []).reduce((acc, row) => {
    const state = String(row.status ?? '').toUpperCase()
    acc.volume += Number(row.amount ?? 0)
    if (state === 'PENDING') acc.pending += 1
    else if (state === 'PAID' || state === 'APPROVED') acc.paid += 1
    else if (state === 'DECLINED') acc.declined += 1
    return acc
  }, { volume: 0, pending: 0, paid: 0, declined: 0 })
  return c.json({ rows: records.data ?? [], total: records.count ?? 0, summary, limit, offset })
})

const userColumns = 'id, username, email, display_name, role, active, last_login_at, failed_login_count, locked_until, created_at'
const permColumns = 'role_key, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export'
const keyColumns = 'id, merchant_id, key_name, api_key, environment, is_active, request_count, secret_prefix, last_used_at, revoked_at, expires_at, created_at'
const BRAND_BUCKET = 'pop'
const BRAND_PREFIX = 'brand-assets/'

function string(value: unknown, max = 160): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}
function number(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
async function audit(actor: { sub: string; username: string }, action: string, entity: string, entityId: string, after: Record<string, unknown>) {
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action, entity, entity_id: entityId, after })
}

adminRoutes.get('/', requirePerm('settings', 'can_view'), async (c) => {
  const [users, roles, permissions, keys, merchants, masters, feeDefaults, hierarchy, capacities, accounts, userPerms, methods] = await Promise.all([
    db.from('panel_users').select(userColumns).order('username'),
    db.from('app_roles').select('role_key, label, active').eq('active', true).order('role_key'),
    db.from('role_page_permissions').select(permColumns).order('page_key').order('role_key'),
    db.from('merchant_api_keys').select(keyColumns).order('created_at', { ascending: false }).limit(200),
    db.from('merchants').select('id, name, code, master_merchant_id, status, is_active').order('name'),
    db.from('master_merchants').select('id, name, code, provider, status').order('name'),
    db.from('master_merchant_fee_defaults').select('id, master_merchant_id, payin_commission_pct, payout_commission_pct, flat_fee_egp, min_monthly_commitment_usd, notes, updated_at').order('updated_at', { ascending: false }),
    db.from('merchants_hierarchy').select('id, master_merchant_id, name, payin_commission_pct, payout_commission_pct, commission_rate, active, created_at').order('name'),
    db.from('wallet_capacity_limits').select('payment_account_id, daily_limit, current_daily_used, updated_at'),
    db.from('payment_accounts').select('id, account_number, label, device_name, payment_method_id, is_active').order('created_at'),
    db.from('user_page_permissions').select('user_id, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export, note, granted_by, updated_at'),
    db.from('payment_methods').select('id, method_code, method_name').order('method_name'),
  ])
  const error = [users, roles, permissions, keys, merchants, masters, feeDefaults, hierarchy, capacities, accounts, userPerms, methods].find((x) => x.error)?.error
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ users: users.data ?? [], roles: roles.data ?? [], permissions: permissions.data ?? [], apiKeys: keys.data ?? [], merchants: merchants.data ?? [], masters: masters.data ?? [], feeDefaults: feeDefaults.data ?? [], hierarchy: hierarchy.data ?? [], capacities: capacities.data ?? [], accounts: accounts.data ?? [], userPermissions: userPerms.data ?? [], methods: methods.data ?? [] })
})

adminRoutes.post('/branding/logo', requirePerm('settings', 'can_edit'), async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  const assetType = String(form?.get('asset_type') ?? '')
  const key = string(form?.get('asset_key'), 160)
  if (!(file instanceof File) || file.size < 1) return c.json({ error: 'logo_file_required' }, 400)
  if (file.size > 2 * 1024 * 1024) return c.json({ error: 'logo_file_too_large', max_mb: 2 }, 400)
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return c.json({ error: 'invalid_logo_type' }, 400)
  if (!['merchant', 'user', 'method'].includes(assetType)) return c.json({ error: 'invalid_asset_type' }, 400)
  if (!key) return c.json({ error: 'asset_key_required' }, 400)
  const actor = c.get('actor')
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  const safeKey = key.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'brand'
  const path = `${BRAND_PREFIX}${assetType}/${safeKey}/${Date.now()}.${ext}`
  const { error } = await db.storage.from(BRAND_BUCKET).upload(path, new Uint8Array(await file.arrayBuffer()), { contentType: file.type, upsert: false })
  if (error) return c.json({ error: 'logo_upload_failed', detail: error.message }, 500)
  const { data: publicData } = db.storage.from(BRAND_BUCKET).getPublicUrl(path)
  const after = { asset_type: assetType, asset_key: key, url: publicData.publicUrl, path, content_type: file.type, size: file.size }
  await audit(actor, 'branding.logo_uploaded', assetType, key, after)
  return c.json({ logo: after }, 201)
})

adminRoutes.post('/users', requirePerm('users', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const username = string(body?.username, 120)?.toLowerCase()
  const password = typeof body?.password === 'string' ? body.password : ''
  const role = string(body?.role, 80)
  if (!username || !/^[^\s]{3,120}$/.test(username) || password.length < 8 || !role) return c.json({ error: 'invalid_user' }, 400)
  // email is optional and separate from username — it is contact information,
  // not a credential. Validated only when supplied, and stored lower-case to
  // match the case-insensitive unique index.
  const email = string(body?.email, 200)?.toLowerCase() ?? null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'invalid_email' }, 400)
  const { data: roleRow } = await db.from('app_roles').select('role_key').eq('role_key', role).eq('active', true).maybeSingle()
  if (!roleRow) return c.json({ error: 'invalid_role' }, 400)
  const { data, error } = await db.from('panel_users').insert({ username, email, password_hash: await hashPassword(password), display_name: string(body?.display_name), role, active: body?.active !== false }).select(userColumns).single()
  if (error) {
    // 23505 is the unique index on lower(email) — say which field collided
    // instead of surfacing a raw Postgres message.
    const taken = error.code === '23505' && error.message.includes('email')
    return c.json({ error: taken ? 'email_taken' : 'db_error', detail: error.message }, 400)
  }
  await audit(c.get('actor'), 'admin.user_created', 'panel_users', data.id, { username: data.username, email: data.email, role: data.role })
  return c.json({ user: data }, 201)
})

// Edit an existing user: display name, email, role, active flag, password.
// Only the fields present in the body change.
//
// Two lock-out rails, because this endpoint can otherwise remove the last way
// back in: nobody may deactivate or demote themselves, and the final active
// steward cannot be deactivated or moved off a steward role by anyone.
const STEWARD_ROLES = ['owner', 'admin', 'super_admin']

adminRoutes.patch('/users/:id', requirePerm('users', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const actor = c.get('actor')

  const { data: before } = await db.from('panel_users').select(userColumns).eq('id', id).maybeSingle()
  if (!before) return c.json({ error: 'not_found' }, 404)

  const update: Record<string, unknown> = {}

  if (body?.display_name !== undefined) update.display_name = string(body.display_name)

  if (body?.email !== undefined) {
    const email = string(body.email, 200)?.toLowerCase() ?? null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'invalid_email' }, 400)
    update.email = email
  }

  if (body?.role !== undefined) {
    const role = string(body.role, 80)
    if (!role) return c.json({ error: 'invalid_role' }, 400)
    const { data: roleRow } = await db.from('app_roles').select('role_key').eq('role_key', role).eq('active', true).maybeSingle()
    if (!roleRow) return c.json({ error: 'invalid_role' }, 400)
    update.role = role
  }

  if (body?.active !== undefined) update.active = body.active === true

  if (body?.password !== undefined && body.password !== '') {
    const password = typeof body.password === 'string' ? body.password : ''
    if (password.length < 8) return c.json({ error: 'password_too_short' }, 400)
    update.password_hash = await hashPassword(password)
  }

  if (Object.keys(update).length === 0) return c.json({ error: 'nothing_to_update' }, 400)

  const losingSteward =
    (update.active === false || (update.role !== undefined && !STEWARD_ROLES.includes(update.role as string))) &&
    STEWARD_ROLES.includes(before.role)

  if (id === actor.sub && (update.active === false || (update.role !== undefined && update.role !== before.role))) {
    return c.json({ error: 'cannot_change_own_access' }, 400)
  }

  if (losingSteward) {
    const { count } = await db
      .from('panel_users')
      .select('id', { count: 'exact', head: true })
      .in('role', STEWARD_ROLES)
      .eq('active', true)
    if ((count ?? 0) <= 1) return c.json({ error: 'last_active_admin' }, 409)
  }

  const { data, error } = await db.from('panel_users').update(update).eq('id', id).select(userColumns).single()
  if (error) {
    const taken = error.code === '23505' && error.message.includes('email')
    return c.json({ error: taken ? 'email_taken' : 'db_error', detail: error.message }, 400)
  }

  // The password hash must never reach the audit log; record only that it moved.
  const { password_hash: _ph, ...safe } = update as Record<string, unknown>
  await audit(actor, 'admin.user_updated', 'panel_users', id, {
    before: { role: before.role, active: before.active, email: before.email, display_name: before.display_name },
    after: { ...safe, ...(update.password_hash ? { password_changed: true } : {}) },
  })
  return c.json({ user: data })
})

// Per-user permission override for one page. The body carries the full action
// set, so this both grants and revokes relative to the role.
adminRoutes.put('/users/:id/permissions/:page', requirePerm('permissions', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const page_key = c.req.param('page')
  const body = await c.req.json().catch(() => null)
  const fields = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'] as const
  if (!/^[\w-]+$/.test(page_key) || !fields.every((k) => typeof body?.[k] === 'boolean')) {
    return c.json({ error: 'invalid_permission' }, 400)
  }
  const actor = c.get('actor')
  const { data: user } = await db.from('panel_users').select('id, role').eq('id', id).maybeSingle()
  if (!user) return c.json({ error: 'not_found' }, 404)
  // Editing your own permissions would let an admin quietly widen their own
  // access with no second pair of eyes.
  if (id === actor.sub) return c.json({ error: 'cannot_change_own_access' }, 400)

  const record = Object.fromEntries(fields.map((k) => [k, body[k]]))
  const { data, error } = await db
    .from('user_page_permissions')
    .upsert({
      user_id: id, page_key, ...record,
      note: string(body?.note, 300),
      granted_by: actor.username,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,page_key' })
    .select()
    .single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(actor, 'admin.user_permission_set', 'user_page_permissions', `${id}:${page_key}`, record)
  return c.json({ override: data })
})

// Drop the override so the page falls back to the role default.
adminRoutes.delete('/users/:id/permissions/:page', requirePerm('permissions', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const page_key = c.req.param('page')
  const actor = c.get('actor')
  if (id === actor.sub) return c.json({ error: 'cannot_change_own_access' }, 400)
  const { error } = await db.from('user_page_permissions').delete().eq('user_id', id).eq('page_key', page_key)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(actor, 'admin.user_permission_cleared', 'user_page_permissions', `${id}:${page_key}`, { page_key })
  return c.json({ ok: true, reverted_to: 'role_default' })
})

adminRoutes.post('/merchants', requirePerm('merchants', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const name = string(body?.name)
  if (!name) return c.json({ error: 'invalid_name' }, 400)
  const code = string(body?.code, 60)?.toUpperCase().replace(/[^A-Z0-9_]/g, '_') ?? `M_${Date.now().toString(36).toUpperCase()}`
  const master_merchant_id = string(body?.master_merchant_id, 60)
  const { data: merchant, error } = await db.from('merchants').insert({
    name, code, email: string(body?.email), phone: string(body?.phone, 40), master_merchant_id,
    status: 'active', is_active: true,
  }).select('id, name, code, master_merchant_id, status, is_active').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  const fee = number(body?.initial_payin_pct)
  if (master_merchant_id && fee !== null) {
    const { error: hierarchyError } = await db.from('merchants_hierarchy').insert({ master_merchant_id, name, payin_commission_pct: fee, payout_commission_pct: number(body?.initial_payout_pct) ?? 0, active: true })
    if (hierarchyError) return c.json({ error: 'merchant_created_fee_failed', detail: hierarchyError.message, merchant }, 409)
  }
  await audit(c.get('actor'), 'admin.merchant_created', 'merchants', merchant.id, { name, code, master_merchant_id })
  return c.json({ merchant }, 201)
})

adminRoutes.put('/permissions/:role/:page', requirePerm('permissions', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const role_key = c.req.param('role')
  const page_key = c.req.param('page')
  const fields = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'] as const
  if (!/^[\w-]+$/.test(role_key) || !/^[\w-]+$/.test(page_key) || !fields.every((key) => typeof body?.[key] === 'boolean')) return c.json({ error: 'invalid_permission' }, 400)
  const { data: role } = await db.from('app_roles').select('role_key').eq('role_key', role_key).maybeSingle()
  if (!role) return c.json({ error: 'invalid_role' }, 404)
  const record = Object.fromEntries(fields.map((key) => [key, body[key]]))
  const { data, error } = await db.from('role_page_permissions').upsert({ role_key, page_key, ...record }, { onConflict: 'role_key,page_key' }).select(permColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(c.get('actor'), 'admin.permission_updated', 'role_page_permissions', `${role_key}:${page_key}`, record)
  return c.json({ permission: data })
})

adminRoutes.put('/fees/defaults/:id', requirePerm('fees', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const update = { payin_commission_pct: number(body?.payin_commission_pct), payout_commission_pct: number(body?.payout_commission_pct), flat_fee_egp: number(body?.flat_fee_egp), min_monthly_commitment_usd: body?.min_monthly_commitment_usd === null ? null : number(body?.min_monthly_commitment_usd), notes: string(body?.notes, 500), updated_at: new Date().toISOString() }
  if (update.payin_commission_pct === null || update.payout_commission_pct === null || update.flat_fee_egp === null || (body?.min_monthly_commitment_usd !== null && update.min_monthly_commitment_usd === null)) return c.json({ error: 'invalid_fee' }, 400)
  const { data, error } = await db.from('master_merchant_fee_defaults').update(update).eq('id', c.req.param('id')).select().maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await audit(c.get('actor'), 'admin.fee_default_updated', 'master_merchant_fee_defaults', c.req.param('id'), update)
  return c.json({ feeDefault: data })
})

adminRoutes.post('/fees/hierarchy', requirePerm('fees', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const master_merchant_id = string(body?.master_merchant_id, 60)
  const name = string(body?.name)
  const payin = number(body?.payin_commission_pct)
  const payout = number(body?.payout_commission_pct) ?? 0
  if (!master_merchant_id || !name || payin === null) return c.json({ error: 'invalid_fee_override' }, 400)
  const { data, error } = await db.from('merchants_hierarchy').insert({ master_merchant_id, name, payin_commission_pct: payin, payout_commission_pct: payout, active: true }).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(c.get('actor'), 'admin.fee_override_created', 'merchants_hierarchy', String(data.id), { master_merchant_id, name, payin, payout })
  return c.json({ override: data }, 201)
})

adminRoutes.put('/fees/hierarchy/:id', requirePerm('fees', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const payin = number(body?.payin_commission_pct)
  const payout = number(body?.payout_commission_pct)
  if (payin === null || payout === null || typeof body?.active !== 'boolean') return c.json({ error: 'invalid_fee_override' }, 400)
  const { data, error } = await db.from('merchants_hierarchy').update({ payin_commission_pct: payin, payout_commission_pct: payout, active: body.active }).eq('id', c.req.param('id')).select().maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await audit(c.get('actor'), 'admin.fee_override_updated', 'merchants_hierarchy', c.req.param('id'), { payin, payout, active: body.active })
  return c.json({ override: data })
})

adminRoutes.get('/fees/resolve', requirePerm('fees', 'can_view'), async (c) => {
  const master = c.req.query('master')?.trim()
  if (!master) return c.json({ error: 'master_required' }, 400)
  const { data, error } = await db.rpc('resolve_effective_commission', { p_master_merchant_code: master, p_sub_merchant_name: c.req.query('sub')?.trim() || null })
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  return c.json({ resolved: data?.[0] ?? null })
})

adminRoutes.put('/capacity/:accountId', requirePerm('wallet_capacity', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const daily_limit = number(body?.daily_limit)
  if (daily_limit === null) return c.json({ error: 'invalid_daily_limit' }, 400)
  const { data, error } = await db.from('wallet_capacity_limits').upsert({ payment_account_id: c.req.param('accountId'), daily_limit, updated_at: new Date().toISOString() }, { onConflict: 'payment_account_id' }).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(c.get('actor'), 'admin.wallet_capacity_updated', 'wallet_capacity_limits', c.req.param('accountId'), { daily_limit })
  return c.json({ capacity: data })
})

adminRoutes.post('/api-keys', requirePerm('api-keys', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const merchant_id = string(body?.merchant_id, 60)
  const key_name = string(body?.key_name)
  const environment = body?.environment === 'live' ? 'live' : body?.environment === 'test' ? 'test' : null
  if (!merchant_id || !key_name || !environment) return c.json({ error: 'invalid_key_request' }, 400)
  const api_key = `otk_${environment}_${randomBytes(12).toString('hex')}`
  const secret = `ots_${environment}_${randomBytes(32).toString('base64url')}`
  const { data, error } = await db.from('merchant_api_keys').insert({ merchant_id, key_name, api_key, secret_hash: sha256Hex(secret), secret_prefix: secret.slice(0, 12), environment, created_by: c.get('actor').sub }).select(keyColumns).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(c.get('actor'), 'admin.api_key_created', 'merchant_api_keys', data.id, { merchant_id, key_name, environment, api_key })
  return c.json({ apiKey: data, secret }, 201)
})

adminRoutes.post('/api-keys/:id/revoke', requirePerm('api-keys', 'can_edit'), async (c) => {
  const now = new Date().toISOString()
  const { data, error } = await db.from('merchant_api_keys').update({ is_active: false, revoked_at: now, updated_at: now }).eq('id', c.req.param('id')).select(keyColumns).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  await audit(c.get('actor'), 'admin.api_key_revoked', 'merchant_api_keys', data.id, { api_key: data.api_key })
  return c.json({ apiKey: data })
})
