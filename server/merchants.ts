import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Merchants directory. NEVER select api_key / secret_key / callback_secret /
// metadata here — credentials stay server-side only (see the exposed-secrets
// incident in the old dashboard).

export const merchantRoutes = new Hono<AuthEnv>()

merchantRoutes.use('*', requireAuth)

const SAFE_COLUMNS =
  'id, name, code, "MID", status, is_active, active, kyc_status, email, phone, business_type, country, country_code, base_currency, website, business_address, primary_contact_name, registration_id, blocked_amount, callback_url, group_id, tier, master_merchant_id, operator_id, key_rotated_at, referred_by_user_id, created_at, updated_at'

merchantRoutes.get('/', requirePerm('merchants', 'can_view'), async (c) => {
  const [merchants, masters, hierarchy] = await Promise.all([
    db.from('merchants').select(SAFE_COLUMNS).order('name'),
    db.from('master_merchants').select('id, name, code:mid'),
    db.from('merchants_hierarchy').select('id, master_merchant_id, name, mid, active, created_at').order('name'),
  ])
  if (merchants.error) return c.json({ error: 'db_error', detail: merchants.error.message }, 500)
  if (masters.error) return c.json({ error: 'db_error', detail: masters.error.message }, 500)
  if (hierarchy.error) return c.json({ error: 'db_error', detail: hierarchy.error.message }, 500)

  // referred_by_user_id -> display name, resolved here rather than via an
  // embedded select: this table's rows don't carry a FK the PostgREST
  // embed syntax can follow (referred_by_user_id was added after the
  // table existed), so a plain lookup map is the simplest correct path.
  const referrerIds = [...new Set((merchants.data ?? []).map((m) => m.referred_by_user_id).filter((id): id is string => !!id))]
  const referrerNames = new Map<string, string>()
  if (referrerIds.length) {
    const { data: referrers } = await db.from('panel_users').select('id, display_name').in('id', referrerIds)
    for (const r of referrers ?? []) referrerNames.set(r.id, r.display_name)
  }
  // Today's volume per merchant (Cairo day) from the daily view.
  const volume = new Map<string, { paid_amt: number; paid_n: number }>()
  const { data: daily } = await db.from('v_merchant_daily_cairo').select('merchant, paid_amt, paid_n').eq('day_cairo', cairoToday())
  for (const d of daily ?? []) volume.set(String(d.merchant), { paid_amt: Number(d.paid_amt ?? 0), paid_n: Number(d.paid_n ?? 0) })
  const rows = (merchants.data ?? []).map((m) => ({
    ...m,
    referred_by_name: m.referred_by_user_id ? referrerNames.get(m.referred_by_user_id) ?? null : null,
    volume_today: volume.get(String(m.name))?.paid_amt ?? 0,
    paid_today: volume.get(String(m.name))?.paid_n ?? 0,
  }))

  return c.json({ rows, masters: masters.data ?? [], hierarchy: hierarchy.data ?? [] })
})

function cairoToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

const TIERS = new Set(['bronze', 'silver', 'gold', 'platinum'])
const PERIODS = new Set(['T+0', 'T+1', 'T+2', 'T+3'])
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)

// Set a merchant's tier.
merchantRoutes.patch('/:id/tier', requirePerm('merchants', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ tier?: unknown }>().catch(() => null)
  const tier = body?.tier === null || body?.tier === '' ? null : String(body?.tier ?? '').toLowerCase()
  if (!isUuid(id) || (tier !== null && !TIERS.has(tier))) return c.json({ error: 'invalid_tier' }, 400)
  const { error } = await db.from('merchants').update({ tier, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_tier_set', entity: 'merchant', entity_id: id, after: { tier } })
  return c.json({ ok: true })
})

// ---- Partners & Groups ----------------------------------------------------
merchantRoutes.get('/groups', requirePerm('merchants', 'can_view'), async (c) => {
  const [groups, members, daily] = await Promise.all([
    db.from('merchant_groups').select('*').order('routing_priority').order('name'),
    db.from('merchants').select('id, name, code, country, status, is_active, kyc_status, tier, group_id'),
    db.from('v_merchant_daily_cairo').select('merchant, day_cairo, paid_amt').gte('day_cairo', cairoToday(-29)),
  ])
  if (groups.error) return c.json({ error: 'db_error', detail: groups.error.message }, 500)
  if (members.error) return c.json({ error: 'db_error', detail: members.error.message }, 500)
  const today = cairoToday()
  const vol30 = new Map<string, number>(); const volToday = new Map<string, number>()
  for (const d of daily.data ?? []) {
    const k = String(d.merchant); const a = Number(d.paid_amt ?? 0)
    vol30.set(k, (vol30.get(k) ?? 0) + a)
    if (d.day_cairo === today) volToday.set(k, (volToday.get(k) ?? 0) + a)
  }
  const merchants = (members.data ?? []).map((m) => ({ ...m, volume_today: volToday.get(String(m.name)) ?? 0, volume_30d: vol30.get(String(m.name)) ?? 0 }))
  const rows = (groups.data ?? []).map((g) => {
    const ms = merchants.filter((m) => m.group_id === g.id)
    return { ...g, merchant_count: ms.length, volume_today: ms.reduce((a, m) => a + m.volume_today, 0), volume_30d: ms.reduce((a, m) => a + m.volume_30d, 0) }
  })
  return c.json({ groups: rows, merchants })
})

function groupPayload(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {}
  if ('name' in body || !partial) { const n = String(body.name ?? '').trim(); if (!n || n.length > 80) return { error: 'invalid_name' } as const; out.name = n }
  if ('description' in body) out.description = body.description ? String(body.description).slice(0, 300) : null
  if ('color' in body) { const col = String(body.color ?? ''); if (!/^#[0-9a-f]{6}$/i.test(col)) return { error: 'invalid_color' } as const; out.color = col }
  if ('commission_rate' in body) { const r = Number(body.commission_rate); if (!Number.isFinite(r) || r < 0 || r > 100) return { error: 'invalid_commission' } as const; out.commission_rate = r }
  if ('routing_priority' in body) { const r = Math.trunc(Number(body.routing_priority)); if (!Number.isFinite(r) || r < 1 || r > 9999) return { error: 'invalid_priority' } as const; out.routing_priority = r }
  if ('settlement_period' in body) { const r = String(body.settlement_period); if (!PERIODS.has(r)) return { error: 'invalid_settlement_period' } as const; out.settlement_period = r }
  if ('daily_volume_cap' in body) { if (body.daily_volume_cap === null || body.daily_volume_cap === '') out.daily_volume_cap = null; else { const r = Number(body.daily_volume_cap); if (!Number.isFinite(r) || r < 0) return { error: 'invalid_cap' } as const; out.daily_volume_cap = r } }
  if ('active' in body) out.active = body.active === true
  return { value: out } as const
}

merchantRoutes.post('/groups', requirePerm('merchants', 'can_create'), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const parsed = groupPayload(body, false)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  const { data, error } = await db.from('merchant_groups').insert(parsed.value).select('*').single()
  if (error) return c.json({ error: error.code === '23505' ? 'group_name_exists' : 'db_error', detail: error.message }, error.code === '23505' ? 409 : 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_group_created', entity: 'merchant_group', entity_id: data.id, after: data })
  return c.json({ ok: true, group: data })
})

// Registered before '/groups/:id' so 'order' is not read as an id.
merchantRoutes.put('/groups/order', requirePerm('merchants', 'can_edit'), async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null)
  const ids = Array.isArray(body?.ids) ? body!.ids.filter(isUuid) : []
  if (!ids.length) return c.json({ error: 'ids_required' }, 400)
  for (let i = 0; i < ids.length; i += 1) {
    const { error } = await db.from('merchant_groups').update({ routing_priority: i + 1, updated_at: new Date().toISOString() }).eq('id', ids[i])
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  }
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_group_order_set', entity: 'merchant_group', entity_id: 'order', after: { ids } })
  return c.json({ ok: true })
})

merchantRoutes.patch('/groups/:id', requirePerm('merchants', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}))
  const parsed = groupPayload(body, true)
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  if (!Object.keys(parsed.value).length) return c.json({ error: 'nothing_to_update' }, 400)
  const { data, error } = await db.from('merchant_groups').update({ ...parsed.value, updated_at: new Date().toISOString() }).eq('id', id).select('*').single()
  if (error) return c.json({ error: error.code === '23505' ? 'group_name_exists' : 'db_error', detail: error.message }, error.code === '23505' ? 409 : 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_group_updated', entity: 'merchant_group', entity_id: id, after: parsed.value })
  return c.json({ ok: true, group: data })
})

merchantRoutes.delete('/groups/:id', requirePerm('merchants', 'can_delete'), async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'invalid_id' }, 400)
  const { count } = await db.from('merchants').select('id', { count: 'exact', head: true }).eq('group_id', id)
  if ((count ?? 0) > 0) return c.json({ error: 'group_not_empty' }, 409)
  const { error } = await db.from('merchant_groups').delete().eq('id', id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_group_deleted', entity: 'merchant_group', entity_id: id })
  return c.json({ ok: true })
})

merchantRoutes.post('/groups/:id/members', requirePerm('merchants', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ merchant_id?: unknown }>().catch(() => null)
  if (!isUuid(id) || !isUuid(body?.merchant_id)) return c.json({ error: 'invalid_request' }, 400)
  const { error } = await db.from('merchants').update({ group_id: id, updated_at: new Date().toISOString() }).eq('id', body!.merchant_id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_group_member_added', entity: 'merchant', entity_id: String(body!.merchant_id), after: { group_id: id } })
  return c.json({ ok: true })
})

merchantRoutes.delete('/groups/:id/members/:merchantId', requirePerm('merchants', 'can_edit'), async (c) => {
  const id = c.req.param('id'); const merchantId = c.req.param('merchantId')
  if (!isUuid(id) || !isUuid(merchantId)) return c.json({ error: 'invalid_request' }, 400)
  const { error } = await db.from('merchants').update({ group_id: null, updated_at: new Date().toISOString() }).eq('id', merchantId).eq('group_id', id)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'merchant_group_member_removed', entity: 'merchant', entity_id: merchantId, after: { group_id: null, from: id } })
  return c.json({ ok: true })
})
