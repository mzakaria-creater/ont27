import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const deviceRoutes = new Hono<AuthEnv>()
deviceRoutes.use('*', requireAuth)

const validDevice = (value: unknown): value is string => typeof value === 'string' && /^ont(?:[1-9]|10)$/.test(value)
const validWallet = (value: unknown): value is string => typeof value === 'string' && /^01\d{9}$/.test(value)
const validSimSlot = (value: unknown) => Number(value) === 1 || Number(value) === 2
const clean = (value: unknown, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) || null : null

deviceRoutes.get('/', requirePerm('sms_live', 'can_view'), async (c) => {
  const [registry, status, sms, walletRows, prefixRows] = await Promise.all([
    db.from('device_registry').select('device, label, sim_number, sim_provider, sms_webhook, active, notes, updated_at').order('device'),
    db.from('device_status').select('device, sim_slot, sim_number, operator, battery, charging, net_type, online, balance, balance_at, last_seen_at').order('device'),
    db.from('inbound_sms').select('id, device_name, amount, sms_category, sender_name, receiver_number, received_at, matched, consumed_by_tx_id, message').order('received_at', { ascending: false, nullsFirst: false }).limit(250),
    db.from('wallet_device_map').select('to_account_number, device, sim_slot, provider, merchant').order('to_account_number').limit(2000),
    db.from('device_prefix_map').select('id, prefix, employee, wallet_number, sim_slot, active, notes, updated_at').order('prefix').order('sim_slot'),
  ])
  if (registry.error && !/device_registry/i.test(registry.error.message)) return c.json({ error: 'db_error', detail: registry.error.message }, 500)
  if (status.error) return c.json({ error: 'db_error', detail: status.error.message }, 500)
  if (sms.error) return c.json({ error: 'db_error', detail: sms.error.message }, 500)
  if (walletRows.error) return c.json({ error: 'db_error', detail: walletRows.error.message }, 500)
  if (prefixRows.error && !/device_prefix_map/i.test(prefixRows.error.message)) return c.json({ error: 'db_error', detail: prefixRows.error.message }, 500)
  const rows = (registry.data ?? []).map((item) => {
    const telemetry = (status.data ?? []).find((row) => row.device === item.device)
    const mappedWallets = (walletRows.data ?? []).filter((row) => row.device === item.device || (row.device == null && telemetry?.sim_slot != null && row.sim_slot === telemetry.sim_slot)).map((row) => ({ wallet_number: row.to_account_number, sim_slot: row.sim_slot, provider: row.provider, merchant: row.merchant }))
    const prefixMap = (prefixRows.data ?? []).filter((row) => row.prefix === item.device)
    const messages = (sms.data ?? []).filter((row) => row.device_name === item.device)
    const today = messages.filter((row) => row.received_at && new Date(row.received_at).toDateString() === new Date().toDateString())
    return { ...item, telemetry: telemetry ?? null, wallet_numbers: mappedWallets, prefix_map: prefixMap, sms_count_24h: messages.filter((row) => row.received_at && Date.now() - Date.parse(row.received_at) < 86_400_000).length, sms_today: today.length, received_today: today.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) }
  })
  return c.json({ devices: rows, sms: sms.data ?? [], prefix_map: prefixRows.data ?? [] })
})

deviceRoutes.post('/', requirePerm('sms_live', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!validDevice(body?.device)) return c.json({ error: 'invalid_device' }, 422)
  const row = { device: body!.device, label: clean(body?.label, 80), sim_number: clean(body?.sim_number, 30), sim_provider: clean(body?.sim_provider, 60), sms_webhook: clean(body?.sms_webhook, 500), active: body?.active !== false, notes: clean(body?.notes, 500), updated_at: new Date().toISOString() }
  const { data, error } = await db.from('device_registry').upsert(row).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'device_registry.upsert', entity: 'device_registry', entity_id: String(body!.device), after: row })
  return c.json({ device: data }, 201)
})

deviceRoutes.patch('/:device', requirePerm('sms_live', 'can_edit'), async (c) => {
  const device = c.req.param('device')
  if (!validDevice(device)) return c.json({ error: 'invalid_device' }, 422)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const patch = { label: clean(body?.label, 80), sim_number: clean(body?.sim_number, 30), sim_provider: clean(body?.sim_provider, 60), sms_webhook: clean(body?.sms_webhook, 500), active: body?.active !== false, notes: clean(body?.notes, 500), updated_at: new Date().toISOString() }
  const { data, error } = await db.from('device_registry').update(patch).eq('device', device).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'device_registry.updated', entity: 'device_registry', entity_id: device, after: patch })
  return c.json({ device: data })
})

deviceRoutes.post('/prefix-map', requirePerm('sms_live', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const prefix = clean(body?.prefix, 20)
  const employee = clean(body?.employee, 120)
  const walletNumber = clean(body?.wallet_number, 30)
  const simSlot = Number(body?.sim_slot)
  if (!validDevice(prefix)) return c.json({ error: 'invalid_prefix' }, 422)
  if (!employee) return c.json({ error: 'employee_required' }, 422)
  if (!validWallet(walletNumber)) return c.json({ error: 'invalid_wallet_number' }, 422)
  if (!validSimSlot(simSlot)) return c.json({ error: 'invalid_sim_slot' }, 422)
  const row = { prefix, employee, wallet_number: walletNumber, sim_slot: simSlot, active: body?.active !== false, notes: clean(body?.notes, 500) }
  const { data, error } = await db.from('device_prefix_map').insert(row).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'device_prefix_map.created', entity: 'device_prefix_map', entity_id: String(data.id), after: data })
  return c.json({ mapping: data }, 201)
})

deviceRoutes.patch('/prefix-map/:id', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_id' }, 422)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const prefix = clean(body?.prefix, 20)
  const employee = clean(body?.employee, 120)
  const walletNumber = clean(body?.wallet_number, 30)
  const simSlot = Number(body?.sim_slot)
  if (!validDevice(prefix)) return c.json({ error: 'invalid_prefix' }, 422)
  if (!employee) return c.json({ error: 'employee_required' }, 422)
  if (!validWallet(walletNumber)) return c.json({ error: 'invalid_wallet_number' }, 422)
  if (!validSimSlot(simSlot)) return c.json({ error: 'invalid_sim_slot' }, 422)
  const { data: before } = await db.from('device_prefix_map').select('*').eq('id', id).maybeSingle()
  const patch = { prefix, employee, wallet_number: walletNumber, sim_slot: simSlot, active: body?.active !== false, notes: clean(body?.notes, 500) }
  const { data, error } = await db.from('device_prefix_map').update(patch).eq('id', id).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'device_prefix_map.updated', entity: 'device_prefix_map', entity_id: String(id), before, after: data })
  return c.json({ mapping: data })
})

deviceRoutes.post('/:device/test', requirePerm('sms_live', 'can_edit'), async (c) => {
  const device = c.req.param('device')
  if (!validDevice(device)) return c.json({ error: 'invalid_device' }, 422)
  const { data } = await db.from('device_registry').select('sms_webhook, active').eq('device', device).maybeSingle()
  if (!data?.active || !data.sms_webhook) return c.json({ error: 'webhook_not_configured' }, 422)
  const started = Date.now()
  try {
    const response = await fetch(data.sms_webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ontarget-test': 'true' }, body: JSON.stringify({ device, sim: 'test', sms: 'OnTarget test SMS', test: true }), signal: AbortSignal.timeout(8000) })
    return c.json({ ok: response.ok, status: response.status, elapsed_ms: Date.now() - started, response: (await response.text()).slice(0, 500) }, response.ok ? 200 : 502)
  } catch (error) { return c.json({ ok: false, elapsed_ms: Date.now() - started, error: error instanceof Error ? error.message : 'webhook_failed' }, 502) }
})
