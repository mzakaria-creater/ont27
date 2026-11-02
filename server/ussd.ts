import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// USSD sender: the panel asks the server to trigger a MacroDroid webhook on a chosen device.
// The webhook URL, the shared key and the wallet PIN never reach the browser after being saved,
// and the PIN is never written to the database, audit log or error messages.
export const ussdRoutes = new Hono<AuthEnv>()
ussdRoutes.use('*', requireAuth)

const NETWORKS = ['orange', 'vodafone'] as const
type Network = (typeof NETWORKS)[number]
const MAX_AMOUNT = Number(process.env.USSD_MAX_AMOUNT ?? 50000)

const validDevice = (v: unknown): v is string => typeof v === 'string' && /^ont(?:[1-9]|1[0-9]|20)$/.test(v)
const validNetwork = (v: unknown): v is Network => typeof v === 'string' && (NETWORKS as readonly string[]).includes(v)
const validPhone = (v: unknown): v is string => typeof v === 'string' && /^01[0-9]{9}$/.test(v)
const validPin = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{4,6}$/.test(v)
const clean = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null)

// Macro identifiers on the phone: orange_send / vodafone_send (see the macro setup notes).
ussdRoutes.get('/config', requirePerm('payouts', 'can_view'), async (c) => {
  const [devices, hooks] = await Promise.all([
    db.from('device_registry').select('device, label, sim_provider, active').order('device'),
    db.from('ussd_webhooks').select('device, network, active, updated_at, secret'),
  ])
  const configured = new Map<string, { active: boolean; has_key: boolean; updated_at: string }>()
  for (const h of hooks.data ?? []) configured.set(`${h.device}:${h.network}`, { active: h.active, has_key: !!h.secret, updated_at: h.updated_at })
  const rows = (devices.data ?? []).map((d) => ({
    device: d.device,
    label: d.label,
    active: d.active,
    orange: configured.get(`${d.device}:orange`) ?? null,
    vodafone: configured.get(`${d.device}:vodafone`) ?? null,
  }))
  return c.json({ devices: rows, max_amount: MAX_AMOUNT })
})

ussdRoutes.put('/webhooks/:device/:network', requirePerm('wallets', 'can_edit'), async (c) => {
  const device = c.req.param('device')
  const network = c.req.param('network')
  if (!validDevice(device)) return c.json({ error: 'invalid_device' }, 422)
  if (!validNetwork(network)) return c.json({ error: 'invalid_network' }, 422)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const webhookUrl = clean(body?.webhook_url, 600)
  if (!webhookUrl || !/^https:\/\/[^\s]+$/.test(webhookUrl)) return c.json({ error: 'invalid_webhook_url' }, 422)
  const actor = c.get('actor')
  const row: Record<string, unknown> = { device, network, webhook_url: webhookUrl, active: body?.active !== false, updated_by: actor.username, updated_at: new Date().toISOString() }
  if (typeof body?.secret === 'string') row.secret = body.secret.trim().slice(0, 120) || null
  const { error } = await db.from('ussd_webhooks').upsert(row, { onConflict: 'device,network' })
  if (error) return c.json({ error: 'db_error' }, 500)
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'ussd_webhook.upserted', entity: 'ussd_webhooks', entity_id: `${device}:${network}`, after: { device, network, active: row.active, key_changed: 'secret' in row } })
  return c.json({ ok: true })
})

ussdRoutes.post('/send', requirePerm('payouts', 'can_edit'), async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const device = body?.device
  const network = body?.network
  const phone = body?.phone
  const pin = body?.pin
  const amount = Number(body?.amount)
  if (!validDevice(device)) return c.json({ error: 'invalid_device' }, 422)
  if (!validNetwork(network)) return c.json({ error: 'invalid_network' }, 422)
  if (!validPhone(phone)) return c.json({ error: 'invalid_phone' }, 422)
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT || Math.round(amount * 100) !== amount * 100) return c.json({ error: 'invalid_amount', max: MAX_AMOUNT }, 422)
  if (!validPin(pin)) return c.json({ error: 'invalid_pin' }, 422)

  const { data: hook } = await db.from('ussd_webhooks').select('webhook_url, secret, active').eq('device', device).eq('network', network).maybeSingle()
  const { data: reg } = await db.from('device_registry').select('active').eq('device', device).maybeSingle()
  if (!hook?.active || !reg?.active) return c.json({ error: 'webhook_not_configured' }, 422)

  const actor = c.get('actor')
  let url: URL
  try { url = new URL(hook.webhook_url) } catch { return c.json({ error: 'invalid_webhook_url' }, 422) }
  url.searchParams.set('phone', phone)
  url.searchParams.set('amount', String(amount))
  url.searchParams.set('pin', pin)
  if (hook.secret) url.searchParams.set('key', hook.secret)

  let httpStatus: number | null = null
  let failure: string | null = null
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    httpStatus = response.status
    if (!response.ok) failure = `http_${response.status}`
  } catch (error) {
    // never echo the error text: undici can embed the request URL (which contains the PIN)
    failure = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error'
  }

  const status = failure ? 'failed' : 'sent'
  const { data: logged } = await db.from('ussd_requests').insert({ device, network, phone, amount, status, http_status: httpStatus, error: failure, requested_by: actor.username }).select('id').single()
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'ussd.send', entity: 'ussd_requests', entity_id: String(logged?.id ?? ''), after: { device, network, phone, amount, status, http_status: httpStatus } })
  return c.json({ ok: !failure, id: logged?.id ?? null, status, http_status: httpStatus, error: failure }, failure ? 502 : 200)
})

ussdRoutes.get('/requests', requirePerm('payouts', 'can_view'), async (c) => {
  const { data, error } = await db.from('ussd_requests').select('id, device, network, phone, amount, status, http_status, error, requested_by, created_at').order('created_at', { ascending: false }).limit(30)
  if (error) return c.json({ error: 'db_error' }, 500)
  return c.json({ requests: data ?? [] })
})
