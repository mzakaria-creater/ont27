import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Telegram alerting config (§8.4). Bot token is stored in maven_runtime_config
// (TELEGRAM_BOT_TOKEN/global) and never returned to the client — only a
// configured/not-configured flag is exposed.

export const telegramRoutes = new Hono<AuthEnv>()
telegramRoutes.use('*', requireAuth)

const TG_KEYS = ['telegram_bot', 'automation']
const audit = (actor: { sub: string; username: string }, action: string, entityId: string, after: Record<string, unknown>) =>
  db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action, entity: 'telegram', entity_id: entityId, after })

telegramRoutes.get('/', requireAnyPerm(TG_KEYS, 'can_view'), async (c) => {
  const [token, chats, gates, alerts] = await Promise.all([
    db.from('maven_runtime_config').select('value').eq('name', 'TELEGRAM_BOT_TOKEN').eq('owner_name', 'global').maybeSingle(),
    db.from('telegram_chats').select('id, chat_id, label, is_active, created_at, receives_daily_report').order('created_at'),
    db.from('telegram_alert_gates').select('alert_type, label, enabled, updated_at').order('alert_type'),
    db.from('telegram_alerts').select('id, alert_type, chat_id, message, ok, error, created_at').order('created_at', { ascending: false }).limit(30),
  ])
  // Bot identity (mirrors @ontargetEGBot into the panel) + whether its updates
  // are bound to an external webhook (e.g. n8n) — in which case live message
  // mirroring here is not possible without disrupting that automation.
  let bot: { username: string | null; name: string | null; webhook: string | null } | null = null
  const botToken = token.data?.value
  if (botToken) {
    try {
      const [meRes, whRes] = await Promise.all([
        fetch(`https://api.telegram.org/bot${botToken}/getMe`).then((r) => r.json() as Promise<{ result?: { username?: string; first_name?: string } }>),
        fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`).then((r) => r.json() as Promise<{ result?: { url?: string } }>),
      ])
      bot = {
        username: meRes?.result?.username ?? null,
        name: meRes?.result?.first_name ?? null,
        webhook: whRes?.result?.url || null,
      }
    } catch { /* bot unreachable — leave null */ }
  }
  return c.json({
    token_configured: !!botToken,
    bot,
    chats: chats.data ?? [],
    gates: gates.data ?? [],
    alerts: alerts.data ?? [],
  })
})

telegramRoutes.put('/token', requireAnyPerm(TG_KEYS, 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const value = typeof body?.token === 'string' ? body.token.trim() : ''
  if (!/^\d+:[\w-]{30,}$/.test(value)) return c.json({ error: 'invalid_token_format' }, 400)
  const { error } = await db.from('maven_runtime_config').upsert(
    { name: 'TELEGRAM_BOT_TOKEN', owner_name: 'global', value },
    { onConflict: 'name,owner_name' },
  )
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(c.get('actor'), 'telegram.token_set', 'TELEGRAM_BOT_TOKEN', { configured: true })
  return c.json({ ok: true })
})

telegramRoutes.post('/chats', requireAnyPerm(TG_KEYS, 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const chat_id = typeof body?.chat_id === 'string' ? body.chat_id.trim() : ''
  const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 120) : null
  if (!/^-?\d+$/.test(chat_id)) return c.json({ error: 'invalid_chat_id' }, 400)
  const { data, error } = await db.from('telegram_chats').insert({ chat_id, label }).select('id, chat_id, label, is_active, created_at').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  await audit(c.get('actor'), 'telegram.chat_add', String(data.id), { chat_id, label })
  return c.json({ chat: data }, 201)
})

telegramRoutes.patch('/chats/:id', requireAnyPerm(TG_KEYS, 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.is_active !== 'boolean') return c.json({ error: 'invalid_is_active' }, 400)
  const { data, error } = await db.from('telegram_chats').update({ is_active: body.is_active }).eq('id', c.req.param('id')).select('id, is_active').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ chat: data })
})

telegramRoutes.patch('/gates/:type', requireAnyPerm(TG_KEYS, 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return c.json({ error: 'invalid_enabled' }, 400)
  const { data, error } = await db.from('telegram_alert_gates').update({ enabled: body.enabled, updated_at: new Date().toISOString() }).eq('alert_type', c.req.param('type')).select('alert_type, enabled').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ gate: data })
})

// Fire a test alert through the real edge function so the whole path is proven.
telegramRoutes.post('/test', requireAnyPerm(TG_KEYS, 'can_edit'), async (c) => {
  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return c.json({ error: 'not_configured' }, 500)
  const actor = c.get('actor')
  const res = await fetch(`${baseUrl}/functions/v1/telegram-notify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
    body: JSON.stringify({ alert_type: 'manual_test', message: `✅ OnTarget test alert by ${actor.username}` }),
  })
  const result = await res.json().catch(() => ({ error: 'invalid_response' }))
  return c.json(result, res.ok ? 200 : (res.status as 400 | 401 | 500))
})
