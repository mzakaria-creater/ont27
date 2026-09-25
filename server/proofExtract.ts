import { Hono } from 'hono'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// AI extraction of payment-proof screenshots (Orange Cash / Vodafone Cash /
// InstaPay / bank transfer confirmations) into structured fields, so an
// operator can cross-check a proof image against the transaction without
// reading it by hand. The image is fetched and forwarded to Claude entirely
// server-side — the API key never reaches the browser, unlike a client-side
// fetch to api.anthropic.com, which would expose it in the page's network
// tab to anyone who opens dev tools.

export const proofExtractRoutes = new Hono<AuthEnv>()
proofExtractRoutes.use('*', requireAuth)

const EXTRACT_PROMPT = `Analyze this payment screenshot (mobile wallet or bank transfer confirmation) and extract the visible financial data. Reply with ONLY a JSON object, no markdown fences, no commentary:
{"type":"INCOMING or OUTGOING or null","amount":number or null,"currency":"EGP or other currency code or null","provider":"Orange Cash / Vodafone Cash / InstaPay / Bank / other or null","sender_name":string or null,"sender_phone":string or null,"receiver_phone":string or null,"trx_id":string or null,"date":string or null,"time":string or null,"balance_after":number or null}
If a field is not visible in the image, use null for it. Do not guess or invent values.`

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

proofExtractRoutes.post('/extract', requireAnyPerm(['deposits', 'payouts', 'sms_live', 'transactions', 'all_transactions'], 'can_view'), async (c) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return c.json({ error: 'ai_not_configured' }, 501)

  const body = await c.req.json().catch(() => null)
  const url = typeof body?.url === 'string' ? body.url : ''
  if (!/^https:\/\//i.test(url)) return c.json({ error: 'invalid_url' }, 400)

  let contentType: string
  let b64: string
  try {
    const imgRes = await fetch(url)
    if (!imgRes.ok) return c.json({ error: 'image_fetch_failed', detail: `HTTP ${imgRes.status}` }, 502)
    contentType = imgRes.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg'
    if (!contentType.startsWith('image/')) return c.json({ error: 'not_an_image' }, 400)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    if (buf.byteLength === 0) return c.json({ error: 'empty_image' }, 400)
    if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ error: 'image_too_large' }, 400)
    b64 = buf.toString('base64')
  } catch (error) {
    return c.json({ error: 'image_fetch_failed', detail: error instanceof Error ? error.message : 'unknown' }, 502)
  }

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
            { type: 'text', text: EXTRACT_PROMPT },
          ],
        }],
      }),
    })
    const aiBody = await aiRes.json().catch(() => null) as { content?: Array<{ text?: string }>; error?: { message?: string } } | null
    if (!aiRes.ok) return c.json({ error: 'ai_request_failed', detail: aiBody?.error?.message ?? `HTTP ${aiRes.status}` }, 502)
    const raw = aiBody?.content?.[0]?.text ?? '{}'
    let extracted: Record<string, unknown>
    try {
      extracted = JSON.parse(raw.replace(/```[\w]*\n?|\n?```/g, '').trim())
    } catch {
      return c.json({ error: 'ai_parse_failed' }, 502)
    }
    return c.json({ extracted })
  } catch (error) {
    return c.json({ error: 'ai_request_failed', detail: error instanceof Error ? error.message : 'unknown' }, 500)
  }
})
