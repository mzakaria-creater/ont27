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
  try {
    await fetch(merchant.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'X-OnTarget-Signature': signature } : {}),
      },
      body,
    })
  } catch (err) {
    console.error('merchant webhook failed:', err)
  }
}
