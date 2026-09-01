import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const payoutRequestRoutes = new Hono<AuthEnv>()
payoutRequestRoutes.use('*', requireAuth)

payoutRequestRoutes.get('/', requirePerm('payouts', 'can_view'), async (c) => {
  const status = c.req.query('status')
  let query = db.from('payout_requests').select('id, merchant_id, merchant_name, master_merchant, wallet_number, amount, note, device, status, requested_by, approved_by, rejected_by, rejection_note, webhook_sent_at, webhook_status, webhook_error, proof_sms, proof_ref, balance_after, screenshot_url, created_at, approved_at, completed_at, failed_at').order('created_at', { ascending: false }).limit(200)
  if (status && status !== 'all') query = query.eq('status', status)
  const { data, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ data: data ?? [] })
})

payoutRequestRoutes.post('/', requirePerm('payouts', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const wallet = String(body?.wallet_number ?? '').replace(/\D/g, '')
  const amount = Number(body?.amount)
  const device = String(body?.device ?? '')
  if (!/^01[0125]\d{8}$/.test(wallet) || !Number.isFinite(amount) || amount <= 0 || amount > 100_000 || !/^ont[1-7]$/.test(device)) return c.json({ error: 'invalid_request' }, 422)
  const { data: deviceRow } = await db.from('device_macrodroid_urls').select('active').eq('device', device).maybeSingle()
  if (!deviceRow?.active) return c.json({ error: 'device_inactive' }, 422)
  const actor = c.get('actor')
  const { data, error } = await db.from('payout_requests').insert({ wallet_number: wallet, amount, device, merchant_id: body?.merchant_id ?? null, merchant_name: body?.merchant_name ?? null, master_merchant: body?.master_merchant ?? null, note: String(body?.note ?? '').slice(0, 500) || null, requested_by: actor.username, status: 'pending' }).select('id, wallet_number, amount, device, note, status, requested_by, created_at').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'payout_request.created', entity: 'payout_requests', entity_id: data.id, after: data })
  return c.json({ data }, 201)
})

payoutRequestRoutes.post('/:id/decision', requirePerm('payouts', 'can_approve'), async (c) => {
  const id = c.req.param('id'); const body = await c.req.json().catch(() => null); const action = body?.action
  if (!['approve', 'reject'].includes(action)) return c.json({ error: 'invalid_action' }, 422)
  const { data: row, error: readError } = await db.from('payout_requests').select('*').eq('id', id).maybeSingle()
  if (readError) return c.json({ error: 'db_error', detail: readError.message }, 500)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.status !== 'pending') return c.json({ error: 'not_pending' }, 409)
  const actor = c.get('actor')
  if (action === 'reject') {
    const update = { status: 'rejected', rejected_by: actor.username, rejection_note: String(body?.reason ?? '').slice(0, 500) || null }
    const { data, error } = await db.from('payout_requests').update(update).eq('id', id).eq('status', 'pending').select().single()
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'payout_request.rejected', entity: 'payout_requests', entity_id: id, before: row, after: data })
    return c.json({ data })
  }
  const { data: device } = await db.from('device_macrodroid_urls').select('macro_url, pin_secret_ref, active').eq('device', row.device).maybeSingle()
  if (!device?.active || !device.macro_url || device.macro_url.includes('PLACEHOLDER')) return c.json({ error: 'device_webhook_not_configured' }, 422)
  const pin = device.pin_secret_ref ? process.env[device.pin_secret_ref] : undefined
  if (!pin) return c.json({ error: 'device_pin_secret_not_configured' }, 422)
  const update = { status: 'approved', approved_by: actor.username, approved_at: new Date().toISOString(), webhook_url: device.macro_url }
  const { data: approved, error: updateError } = await db.from('payout_requests').update(update).eq('id', id).eq('status', 'pending').select().single()
  if (updateError) return c.json({ error: 'db_error', detail: updateError.message }, 500)
  let webhookStatus: number | null = null; let webhookError: string | null = null
  try {
    const url = new URL(device.macro_url); url.searchParams.set('phone', row.wallet_number); url.searchParams.set('amount', String(row.amount)); url.searchParams.set('pin', pin); url.searchParams.set('request_id', id)
    const response = await fetch(url, { method: 'GET' }); webhookStatus = response.status
    if (!response.ok) webhookError = `HTTP ${response.status}`
  } catch (error) { webhookError = error instanceof Error ? error.message : 'webhook_failed' }
  const finalUpdate = { status: webhookStatus && webhookStatus >= 200 && webhookStatus < 300 ? 'executing' : 'failed', webhook_sent_at: new Date().toISOString(), webhook_status: webhookStatus, webhook_error: webhookError, failed_at: webhookError ? new Date().toISOString() : null }
  const { data: result } = await db.from('payout_requests').update(finalUpdate).eq('id', id).select().single()
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'payout_request.approved', entity: 'payout_requests', entity_id: id, before: row, after: { ...approved, ...finalUpdate, executed_on_provider: !webhookError } })
  return c.json({ data: result, executed_on_provider: !webhookError, webhook_status: webhookStatus, webhook_error: webhookError })
})
