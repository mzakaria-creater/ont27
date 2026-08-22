import { createHmac } from 'node:crypto'
import { db } from './db.js'

export interface TelegramDelivery {
  ok: boolean
  sent: number
  error?: string
  results?: unknown[]
}

// Canonical Telegram path. It keeps tokens and routing inside the Supabase
// Edge Function, where alert gates and active chat selection are enforced.
export async function sendTelegramAlert(alertType: string, text: string, chatIds?: string[]): Promise<TelegramDelivery> {
  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return { ok: false, sent: 0, error: 'telegram_not_configured' }
  try {
    const response = await fetch(`${baseUrl}/functions/v1/telegram-notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ alert_type: alertType, message: text, ...(chatIds?.length ? { chat_ids: chatIds } : {}) }),
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    const delivery = {
      ok: response.ok,
      sent: Number(result.sent ?? 0),
      error: response.ok ? undefined : String(result.error ?? `HTTP ${response.status}`),
      results: Array.isArray(result.results) ? result.results : undefined,
    }
    if (!delivery.ok) console.error('telegram edge delivery failed:', { alertType, error: delivery.error })
    return delivery
  } catch (error) {
    const message = error instanceof Error ? error.message : 'send_failed'
    console.error('telegram edge delivery failed:', { alertType, error: message })
    return { ok: false, sent: 0, error: message }
  }
}

// Ops notification to Telegram — env-driven; silently skipped when unconfigured.
export async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
  } catch (err) {
    console.error('telegram notify failed:', err)
  }
}

// Merchant webhook with HMAC-SHA256 signature (v3 blueprint: X-OnTarget-Signature).
// No retry queue yet — failures are logged; retry queue lands with the Deposits build.
export async function notifyMerchantWebhook(
  merchantId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { data: merchant } = await db
    .from('merchants')
    .select('callback_url, callback_secret')
    .eq('id', merchantId)
    .maybeSingle()
  if (!merchant?.callback_url) return
  const body = JSON.stringify(payload)
  const signature = merchant.callback_secret
    ? createHmac('sha256', merchant.callback_secret).update(body).digest('hex')
    : undefined
  const started = Date.now()
  try {
    const response = await fetch(merchant.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-OnTarget-Signature': signature } : {}),
      },
      body,
    })
    await db.from('audit_log').insert({
      actor_type: 'system', actor_name: 'webhook-dispatcher',
      action: response.ok ? 'webhook.delivered' : 'webhook.failed',
      entity: 'merchant_callback', entity_id: merchantId,
      after: { status: response.status, latency_ms: Date.now() - started, destination_host: new URL(merchant.callback_url).host },
    })
  } catch (err) {
    console.error('merchant webhook failed:', err)
    await db.from('audit_log').insert({
      actor_type: 'system', actor_name: 'webhook-dispatcher', action: 'webhook.failed',
      entity: 'merchant_callback', entity_id: merchantId,
      after: { status: null, latency_ms: Date.now() - started, destination_host: new URL(merchant.callback_url).host,
        error: err instanceof Error ? err.message.slice(0, 300) : 'network_error' },
    })
  }
}
