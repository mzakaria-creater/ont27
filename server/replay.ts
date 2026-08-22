import { createHmac, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const replayRoutes = new Hono<AuthEnv>()
replayRoutes.use('*', requireAuth)

const norm = (value: unknown) => String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')

async function simulate(amount: number, senderName: string, receivedAt: string) {
  const at = Date.parse(receivedAt)
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(at)) throw new Error('invalid_simulation')
  const { data, error } = await db.from('maven_transactions')
    .select('tx_id, ontarget_ref, amount, status, sender_name, sender_number, merchant, first_seen_at')
    .eq('amount', amount).in('status', ['PENDING', 'PAID', 'APPROVED', 'UNDERPAID'])
    .gte('first_seen_at', new Date(at - 3 * 86_400_000).toISOString())
    .lte('first_seen_at', new Date(at + 3 * 86_400_000).toISOString())
    .order('first_seen_at', { ascending: false }).limit(50)
  if (error) throw new Error(error.message)
  const inputName = norm(senderName)
  return (data ?? []).map((row) => {
    const seconds = row.first_seen_at ? Math.round(Math.abs(Date.parse(row.first_seen_at) - at) / 1000) : null
    const nameExact = Boolean(inputName) && norm(row.sender_name) === inputName
    const within10m = seconds != null && seconds <= 600
    return { ...row, score: (nameExact ? 60 : 0) + (within10m ? 35 : 0) + 5, signals: { amount_exact: true, name_exact: nameExact, within_10_minutes: within10m, seconds_difference: seconds } }
  }).sort((a, b) => b.score - a.score)
}

replayRoutes.post('/sms/simulate', requirePerm('automation', 'can_view'), async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    const candidates = await simulate(Number(body?.amount), String(body?.sender_name ?? ''), String(body?.received_at ?? ''))
    return c.json({ dry_run: true, candidates, unique_strict_match: candidates.filter((row) => row.signals.name_exact && row.signals.within_10_minutes).length === 1 })
  } catch { return c.json({ error: 'invalid_simulation' }, 400) }
})

replayRoutes.post('/sms/:id/replay', requirePerm('automation', 'can_view'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad_id' }, 400)
  const { data: sms, error } = await db.from('inbound_sms').select('id, amount, sender_name, received_at, consumed_by_tx_id').eq('id', id).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.amount == null || !sms.received_at) return c.json({ error: 'sms_missing_match_fields' }, 409)
  const candidates = await simulate(Number(sms.amount), String(sms.sender_name ?? ''), sms.received_at)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.replay_dry_run', entity: 'inbound_sms', entity_id: String(id), after: { candidates: candidates.length, existing_tx_id: sms.consumed_by_tx_id } })
  return c.json({ dry_run: true, sms, candidates, unique_strict_match: candidates.filter((row) => row.signals.name_exact && row.signals.within_10_minutes).length === 1 })
})

replayRoutes.get('/webhooks', requirePerm('automation', 'can_view'), async (c) => {
  const { data, error } = await db.from('merchants').select('id, name, callback_url').not('callback_url', 'is', null).order('name')
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ merchants: data ?? [] })
})

replayRoutes.post('/webhooks/:merchantId', requirePerm('automation', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  if (body?.confirmation !== 'REPLAY WEBHOOK' || !body?.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return c.json({ error: 'explicit_confirmation_required' }, 400)
  const { data: merchant, error } = await db.from('merchants').select('id, name, callback_url, callback_secret').eq('id', c.req.param('merchantId')).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!merchant?.callback_url) return c.json({ error: 'callback_not_configured' }, 409)
  const payload = JSON.stringify(body.payload)
  const key = randomUUID()
  const signature = merchant.callback_secret ? createHmac('sha256', merchant.callback_secret).update(payload).digest('hex') : null
  const started = Date.now()
  let status: number | null = null; let responseText = ''; let failure: string | null = null
  try {
    const response = await fetch(merchant.callback_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ontarget-idempotency-key': key, ...(signature ? { 'x-ontarget-signature': signature } : {}) }, body: payload, signal: AbortSignal.timeout(12_000) })
    status = response.status; responseText = (await response.text()).slice(0, 1000)
  } catch (e) { failure = e instanceof Error ? e.message : 'delivery_failed' }
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: status != null && status >= 200 && status < 300 ? 'webhook.replay_delivered' : 'webhook.replay_failed', entity: 'merchant_callback', entity_id: merchant.id, after: { idempotency_key: key, status, latency_ms: Date.now() - started, destination_host: new URL(merchant.callback_url).host, failure } })
  return c.json({ ok: status != null && status >= 200 && status < 300, idempotency_key: key, status, response: responseText, failure }, status == null ? 502 : 200)
})
