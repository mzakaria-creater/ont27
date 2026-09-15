import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from './db.js'
import { requireAnyPerm, requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const whatsappRoutes = new Hono<AuthEnv>()
whatsappRoutes.use('*', requireAuth)
whatsappRoutes.use('*', requireAnyPerm(['whatsapp', 'support'], 'can_view'))

const safeConversation = 'id, phone, contact_name, status, assigned_to, linked_tx_ref, last_message_at, unread_count, created_at, updated_at'
const safeMessage = 'id, conversation_id, direction, body, message_type, status, wa_message_id, created_at'

whatsappRoutes.get('/', async (c) => {
  const q = c.req.query('q')?.trim()
  const status = c.req.query('status')
  let query = db.from('whatsapp_conversations').select(safeConversation).order('last_message_at', { ascending: false }).limit(100)
  if (q) query = query.or(`phone.ilike.%${q}%,contact_name.ilike.%${q}%,linked_tx_ref.ilike.%${q}%`)
  if (status === 'open' || status === 'closed') query = query.eq('status', status)
  const [{ data: conversations, error }, { data: operators }] = await Promise.all([
    query,
    db.from('panel_users').select('id, username, display_name, role').eq('active', true).order('display_name'),
  ])
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ conversations: conversations ?? [], operators: operators ?? [], configured: !!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID })
})

whatsappRoutes.get('/conversations/:id/messages', async (c) => {
  const { data, error } = await db.from('whatsapp_messages').select(safeMessage).eq('conversation_id', c.req.param('id')).order('created_at', { ascending: true }).limit(500)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', c.req.param('id'))
  return c.json({ messages: data ?? [] })
})

whatsappRoutes.patch('/conversations/:id', requireAnyPerm(['whatsapp', 'support'], 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const patch: Record<string, unknown> = {}
  if (body?.status === 'open' || body?.status === 'closed') patch.status = body.status
  if (typeof body?.assigned_to === 'string' || body?.assigned_to === null) patch.assigned_to = body.assigned_to
  if (typeof body?.linked_tx_ref === 'string' || body?.linked_tx_ref === null) patch.linked_tx_ref = body.linked_tx_ref
  if (!Object.keys(patch).length) return c.json({ error: 'no_changes' }, 400)
  patch.updated_at = new Date().toISOString()
  const { data, error } = await db.from('whatsapp_conversations').update(patch).eq('id', c.req.param('id')).select(safeConversation).maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ conversation: data })
})

whatsappRoutes.post('/conversations/:id/messages', requireAnyPerm(['whatsapp', 'support'], 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const text = typeof body?.body === 'string' ? body.body.trim().slice(0, 4096) : ''
  if (!text) return c.json({ error: 'message_required' }, 400)
  const { data: conversation } = await db.from('whatsapp_conversations').select('id, phone').eq('id', c.req.param('id')).maybeSingle()
  if (!conversation) return c.json({ error: 'not_found' }, 404)
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) return c.json({ error: 'whatsapp_not_configured' }, 503)
  const response = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: conversation.phone, type: 'text', text: { body: text } }) })
  const result = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } }
  if (!response.ok) return c.json({ error: 'whatsapp_send_failed', detail: result.error?.message ?? 'Meta API error' }, 502)
  const { data: message, error } = await db.from('whatsapp_messages').insert({ conversation_id: conversation.id, direction: 'outbound', body: text, message_type: 'text', status: 'sent', wa_message_id: result.messages?.[0]?.id ?? null }).select(safeMessage).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('whatsapp_conversations').update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', conversation.id)
  return c.json({ message }, 201)
})

// Meta Cloud API webhook. Verification is public; incoming messages are persisted
// without exposing the access token to the browser.
export const whatsappWebhookRoutes = new Hono()
const hasValidMetaSignature = (body: string, signature: string | undefined, secret: string): boolean => {
  if (!signature?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const supplied = Buffer.from(signature)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

whatsappWebhookRoutes.get('/', (c) => {
  const mode = c.req.query('hub.mode'); const token = c.req.query('hub.verify_token'); const challenge = c.req.query('hub.challenge')
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) return c.text(challenge ?? '')
  return c.text('forbidden', 403)
})
whatsappWebhookRoutes.post('/', async (c) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET
  if (!appSecret) return c.json({ error: 'whatsapp_webhook_not_configured' }, 503)
  const rawBody = await c.req.text()
  if (!hasValidMetaSignature(rawBody, c.req.header('x-hub-signature-256'), appSecret)) {
    return c.json({ error: 'invalid_signature' }, 401)
  }
  let payload: Record<string, unknown> | null = null
  try { payload = JSON.parse(rawBody || 'null') as Record<string, unknown> | null } catch { /* handled below */ }
  if (!payload || typeof payload !== 'object') return c.json({ error: 'invalid_payload' }, 400)
  for (const entry of (payload.entry as Array<Record<string, unknown>> | undefined) ?? []) for (const change of (entry.changes as Array<Record<string, any>> | undefined) ?? []) {
    for (const item of change.value?.messages ?? []) {
      const phone = String(item.from ?? '').trim(); const text = String(item.text?.body ?? item.button?.text ?? '').trim()
      if (!phone || !text) continue
      const now = new Date().toISOString()
      const { data: existing } = await db.from('whatsapp_conversations').select('id, unread_count').eq('phone', phone).maybeSingle()
      const conversation = existing ?? (await db.from('whatsapp_conversations').insert({ phone, contact_name: change.value?.contacts?.[0]?.profile?.name ?? phone, status: 'open', last_message_at: now, unread_count: 0 }).select('id, unread_count').single()).data
      if (!conversation) continue
      await db.from('whatsapp_messages').upsert({ conversation_id: conversation.id, direction: 'inbound', body: text, message_type: item.type ?? 'text', status: 'received', wa_message_id: item.id ?? null }, { onConflict: 'wa_message_id' })
      await db.from('whatsapp_conversations').update({ last_message_at: now, updated_at: now, unread_count: Number(conversation.unread_count ?? 0) + 1 }).eq('id', conversation.id)
    }
  }
  return c.json({ received: true })
})
