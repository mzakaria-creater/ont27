import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const deviceRoutes = new Hono<AuthEnv>()
deviceRoutes.use('*', requireAuth)

const validDevice = (value: unknown) => typeof value === 'string' && /^ont(?:[1-9]|10)$/.test(value)
const clean = (value: unknown, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) || null : null

deviceRoutes.get('/', requirePerm('sms_live', 'can_view'), async (c) => {
  const [registry, status, sms] = await Promise.all([
    db.from('device_registry').select('device, label, sim_number, sim_provider, sms_webhook, active, notes, updated_at').order('device'),
    db.from('device_status').select('device, sim_slot, sim_number, operator, battery, charging, net_type, online, balance, balance_at, last_seen_at').order('device'),
    db.from('inbound_sms').select('id, device_name, amount, sms_category, sender_name, receiver_number, received_at, matched, consumed_by_tx_id, message').order('received_at', { ascending: false, nullsFirst: false }).limit(250),
  ])
  if (registry.error && !/device_registry/i.test(registry.error.message)) return c.json({ error: 'db_error', detail: registry.error.message }, 500)
  if (status.error) return c.json({ error: 'db_error', detail: status.error.message }, 500)
  if (sms.error) return c.json({ error: 'db_error', detail: sms.error.message }, 500)
  const rows = (registry.data ?? []).map((item) => {
    const telemetry = (status.data ?? []).find((row) => row.device === item.device)
    const messages = (sms.data ?? []).filter((row) => row.device_name === item.device)
    const today = messages.filter((row) => row.received_at && new Date(row.received_at).toDateString() === new Date().toDateString())
    return { ...item, telemetry: telemetry ?? null, sms_count_24h: messages.filter((row) => row.received_at && Date.now() - Date.parse(row.received_at) < 86_400_000).length, sms_today: today.length, received_today: today.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) }
  })
  return c.json({ devices: rows, sms: sms.data ?? [] })
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
  return c.json({ device: data })
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
