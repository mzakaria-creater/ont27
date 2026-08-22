import { createHmac } from 'node:crypto'
import { db } from './db.js'

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
