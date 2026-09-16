import { Hono } from 'hono'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { db } from './db.js'
import { allocateWallet } from './allocate.js'
import { notifyTelegram } from './notify.js'
import { idempotencyKey, recordPaymentOperation } from './paymentArchitecture.js'

const SESSION_TTL_MIN = 15

interface LinkRow {
  id: string
  merchant_id: string | null
  short_code: string
  title: string | null
  amount_mode: 'fixed' | 'open'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
  currency: string
  expires_at: string | null
  max_uses: number | null
  use_count: number
  active: boolean
  client_name?: string | null
  client_reference?: string | null
  return_url?: string | null
  payment_method_codes?: string[] | null
  wallet_pool_id?: string | null
  allocation_mode?: 'single_queue' | 'multi_wallet'
  multi_wallet_threshold?: number | null
  require_name?: boolean | null
  checkout_token_hash?: string | null
}

async function merchantIdentity(merchantId: string | null | undefined) {
  if (!merchantId) return { merchantMid: null, masterMid: null }
  const { data: merchant } = await db.from('merchants').select('"MID", master_merchant_id').eq('id', merchantId).maybeSingle()
  if (!merchant) return { merchantMid: null, masterMid: null }
  const { data: master } = merchant.master_merchant_id
    ? await db.from('master_merchants').select('mid').eq('id', merchant.master_merchant_id).maybeSingle()
    : { data: null }
  return { merchantMid: merchant.MID ?? null, masterMid: master?.mid ?? null }
}

function linkUsable(link: LinkRow): string | null {
  if (!link.active) return 'link_disabled'
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'link_expired'
  if (link.max_uses !== null && link.use_count >= link.max_uses) return 'link_exhausted'
  return null
}

// Salted daily digest of IP + user agent. Enough to tell one visitor from
// another within a day; not reversible into an address, and it rolls over
// nightly so it cannot be joined across days into a browsing history. The
// salt is the JWT secret, which is already required to be set — with no
// secret the digest is skipped entirely rather than falling back to something
// predictable that would let anyone reconstruct the input.
function visitorDigest(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const salt = process.env.PANEL_JWT_SECRET
  if (!salt) return null
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip') ?? ''
  const ua = c.req.header('user-agent') ?? ''
  if (!ip && !ua) return null
  const day = new Date().toISOString().slice(0, 10)
  return createHash('sha256').update(`${salt}|${day}|${ip}|${ua}`).digest('hex').slice(0, 32)
}

// Recorded for EVERY view, refused ones included: a link nobody can use any
// more but that people keep opening is the single most useful thing this
// table can show, and it is invisible if only successful views are kept.
// Never allowed to fail the request — an analytics write must not stop a
// customer reaching a payment page.
async function recordOpen(
  link: { id: string; short_code: string },
  blockedReason: string | null,
  c: { req: { header: (k: string) => string | undefined } },
): Promise<void> {
  try {
    await db.from('payment_link_opens').insert({
      link_id: link.id,
      short_code: link.short_code,
      visitor_hash: visitorDigest(c),
      blocked_reason: blockedReason,
    })
  } catch (e) {
    console.error('payment_link_opens insert failed:', e)
  }
}

async function dispatchPaymentCreatedWebhook(session: Record<string, any>, paymentId: string, method: string | null) {
  if (!session.merchant_id) return
  const { data: endpoints } = await db.from('webhook_endpoints')
    .select('id, url, signing_secret, event_types')
    .eq('merchant_id', session.merchant_id)
    .eq('direction', 'outbound')
    .eq('is_active', true)
  const endpoint = (endpoints ?? []).find((row: any) => !row.event_types?.length || row.event_types.includes('payment.created'))
  if (!endpoint?.url || !/^https:\/\//i.test(endpoint.url)) return
  const payload = {
    type: 'payment.created',
    id: paymentId,
    reference: session.reference,
    amount: session.amount,
    currency: session.currency,
    payment_method: method,
    status: 'pending',
    merchant_id: session.merchant_id,
    created_at: session.created_at,
  }
  const raw = JSON.stringify(payload)
  const started = Date.now()
  const signature = endpoint.signing_secret ? `sha256=${createHmac('sha256', endpoint.signing_secret).update(raw).digest('hex')}` : ''
  let statusCode: number | null = null
  let error: string | null = null
  try {
    const response = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ontarget-event': 'payment.created', ...(signature ? { 'x-ontarget-signature': signature } : {}) }, body: raw, signal: AbortSignal.timeout(5000) })
    statusCode = response.status
    if (!response.ok) error = `http_${response.status}`
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 240) : 'webhook_failed'
  }
  await db.from('webhook_delivery_log').insert({
    endpoint_id: endpoint.id, direction: 'outbound', event_type: 'payment.created', status_code: statusCode,
    success: !error, latency_ms: Date.now() - started, request_id: paymentId, error,
    payload: { ...payload, signature_present: Boolean(signature) },
  })
}

function publicSession(s: Record<string, unknown>) {
  const meta = (s.metadata ?? {}) as Record<string, unknown>
  const expired =
    s.status === 'pending' && s.expires_at && new Date(s.expires_at as string).getTime() < Date.now()
  return {
    id: s.id,
    reference: s.reference,
    status: expired ? 'expired' : s.status,
    amount: s.amount,
    currency: s.currency,
    customer_phone: s.customer_phone,
    wallet_number: meta.wallet_number ?? null,
    provider: meta.provider ?? null,
    channel_name: meta.channel_name ?? null,
    deeplink: meta.deeplink ?? null,
    wallets: meta.wallets ?? null,
    return_url: s.success_url ?? meta.return_url ?? null,
    merchant_name: meta.merchant_name ?? null,
    merchant_mid: meta.merchant_mid ?? null,
    master_mid: meta.master_mid ?? null,
    usd_amount: meta.usd_amount ?? null,
    fx_rate_used: meta.fx_rate_used ?? null,
    customer_proof_url: meta.customer_proof_url ?? null,
    customer_proof_note: meta.customer_proof_note ?? null,
    created_at: s.created_at,
    expires_at: s.expires_at,
    paid_at: s.paid_at,
  }
}

export const payRoutes = new Hono()

payRoutes.get('/link/:code', async (c) => {
  const supplied = c.req.param('code')
  const tokenHash = /^[a-f0-9]{64}$/i.test(supplied) ? createHash('sha256').update(supplied).digest('hex') : null
  let query = db
    .from('payment_links')
    .select('*')
  query = tokenHash ? query.eq('checkout_token_hash', tokenHash) : query.eq('short_code', supplied)
  const { data: link } = await query.maybeSingle<LinkRow>()
  if (!link) return c.json({ error: 'link_not_found' }, 404)
  const unusable = linkUsable(link)
  await recordOpen(link, unusable, c)
  if (unusable) return c.json({ error: unusable }, 410)
  const identity = await merchantIdentity(link.merchant_id)
  return c.json({
    link: {
      short_code: link.short_code,
      title: link.title,
      amount_mode: link.amount_mode,
      amount: link.amount,
      min_amount: link.min_amount,
      max_amount: link.max_amount,
      currency: link.currency,
      client_name: link.client_name ?? null,
      client_reference: link.client_reference ?? null,
      return_url: link.return_url ?? null,
      payment_method_codes: link.payment_method_codes ?? [],
      allocation_mode: link.allocation_mode ?? 'single_queue',
      multi_wallet_threshold: link.multi_wallet_threshold ?? null,
      require_name: link.require_name === true,
      merchant_mid: identity.merchantMid,
      master_mid: identity.masterMid,
    },
  })
})

payRoutes.post('/session', async (c) => {
  const body = await c.req.json().catch(() => null)
  const requestIdempotency = c.req.header('idempotency-key')?.trim() || (typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '')
  if (!requestIdempotency) return c.json({ error: 'idempotency_key_required' }, 400)
  const code = typeof body?.code === 'string' ? body.code.trim() : null
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : null
  const requestedMethod = typeof body?.payment_method_code === 'string' ? body.payment_method_code.trim().toUpperCase() : null
  const rawAmount = Number(body?.amount)

  if (!/^01[0-9]{9}$/.test(phone)) return c.json({ error: 'invalid_phone' }, 400)

  let link: LinkRow | null = null
  if (code) {
    const tokenHash = code && /^[a-f0-9]{64}$/i.test(code) ? createHash('sha256').update(code).digest('hex') : null
    let linkQuery = db
      .from('payment_links')
      .select('*')
    linkQuery = tokenHash ? linkQuery.eq('checkout_token_hash', tokenHash) : linkQuery.eq('short_code', code)
    const { data } = await linkQuery.maybeSingle<LinkRow>()
    if (!data) return c.json({ error: 'link_not_found' }, 404)
    const unusable = linkUsable(data)
    if (unusable) return c.json({ error: unusable }, 410)
    link = data
  }

  if (link?.require_name && !name) return c.json({ error: 'name_required' }, 400)

  let currency = link?.currency ?? 'EGP'
  let amount = link?.amount_mode === 'fixed' ? Number(link.amount) : rawAmount
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 400)
  amount = Math.round(amount * 100) / 100
  const idem = idempotencyKey(requestIdempotency, `${phone}:${amount}:${currency}`)
  const { data: previous } = await db.from('payment_idempotency_keys').select('response_status, response_payload').eq('scope', link?.merchant_id ?? 'public').eq('idempotency_key', idem).eq('operation', 'create').gt('expires_at', new Date().toISOString()).maybeSingle()
  if (previous?.response_payload) return c.json(previous.response_payload, previous.response_status === 201 ? 201 : 200)
  if (link?.amount_mode === 'open') {
    if (link.min_amount !== null && amount < link.min_amount) return c.json({ error: 'amount_below_min', min: link.min_amount }, 400)
    if (link.max_amount !== null && amount > link.max_amount) return c.json({ error: 'amount_above_max', max: link.max_amount }, 400)
  }

  // Wallets, matching, and every downstream admin view assume EGP. A
  // USD-denominated link is therefore converted to EGP right here, once,
  // using the latest stored rate — the customer sees the conversion on the
  // checkout page before submitting, and the original USD figure + rate
  // used are kept in metadata for audit.
  let usdAmount: number | null = null
  let fxRate: number | null = null
  if (currency === 'USD') {
    const { data: rateRow } = await db.from('exchange_rates').select('rate').eq('currency_pair', 'USD/EGP').order('fetched_at', { ascending: false }).limit(1).maybeSingle()
    if (!rateRow?.rate || !(Number(rateRow.rate) > 0)) return c.json({ error: 'rate_unavailable' }, 503)
    fxRate = Number(rateRow.rate)
    usdAmount = amount
    amount = Math.round(amount * fxRate * 100) / 100
    currency = 'EGP'
  }

  const allowedMethods = (link?.payment_method_codes ?? []).map((method) => method.toUpperCase())
  if (requestedMethod && allowedMethods.length && !allowedMethods.includes(requestedMethod)) {
    return c.json({ error: 'payment_method_not_allowed' }, 400)
  }

  const wallet = await allocateWallet(currency, {
    poolId: link?.wallet_pool_id,
    methodCodes: requestedMethod ? [requestedMethod] : allowedMethods,
    amount,
    mode: link?.allocation_mode,
    multiWalletThreshold: link?.multi_wallet_threshold,
  })
  if (!wallet) return c.json({ error: 'no_channel_available' }, 503)

  if (link) {
    const { data: used, error } = await db.rpc('use_payment_link', { p_link_id: link.id })
    if (error || used === null) return c.json({ error: 'link_exhausted' }, 410)
  }

  const reference = `OT-${randomBytes(5).toString('hex').toUpperCase()}`
  const checkoutToken = randomBytes(32).toString('hex')
  const checkoutTokenHash = createHash('sha256').update(checkoutToken).digest('hex')
  const identity = await merchantIdentity(link?.merchant_id)
  const deeplink = wallet.deeplinkTemplate
    ?.replaceAll('{wallet}', wallet.walletNumber)
    .replaceAll('{amount}', String(amount)) ?? null

  const { data: session, error } = await db
    .from('checkout_sessions')
    .insert({
      merchant_id: link?.merchant_id ?? null,
      payment_link_id: link?.id ?? null,
      reference,
      status: 'pending',
      amount,
      currency,
      pay_currency: currency,
      pay_amount: amount,
      customer_phone: phone,
      customer_name: name,
      local_deposit_channel_id: wallet.channelId,
      payment_method_id: wallet.paymentMethodId ?? null,
      wallet_id: wallet.accountId ?? null,
      success_url: link?.return_url ?? null,
      expires_at: new Date(Date.now() + SESSION_TTL_MIN * 60_000).toISOString(),
      metadata: {
        wallet_number: wallet.walletNumber,
        provider: wallet.provider,
        device: wallet.device,
        channel_name: wallet.channelName,
        channel_type: wallet.channelType,
        deeplink,
        wallets: wallet.allocations ?? null,
        return_url: link?.return_url ?? null,
        merchant_name: link?.client_name ?? null,
        merchant_mid: identity.merchantMid,
        master_mid: identity.masterMid,
        client_reference: link?.client_reference ?? null,
        payment_method_code: wallet.paymentMethodCode ?? requestedMethod ?? null,
        usd_amount: usdAmount,
        fx_rate_used: fxRate,
      },
      checkout_token_hash: checkoutTokenHash,
    })
    .select('*')
    .single()
  if (error || !session) {
    console.error('session insert failed:', error?.message)
    return c.json({ error: 'session_create_failed' }, 500)
  }

  const operation = await recordPaymentOperation({
    publicId: reference,
    checkoutSessionId: session.id,
    merchantId: link?.merchant_id ?? null,
    amount,
    currency,
    method: wallet.paymentMethodCode ?? requestedMethod,
    operation: 'create',
    idempotency: idem,
    request: { code, phone, name, amount, payment_method_code: requestedMethod, wallet_number: wallet.walletNumber },
  })

  void notifyTelegram(
    `🟡 طلب إيداع جديد\nRef: <code>${reference}</code>\nAmount: ${amount} ${currency}\nWallet: <code>${wallet.walletNumber}</code> (${wallet.device})\nPhone: <code>${phone}</code>`,
  )

  const response = {
    session: {
      ...publicSession(session),
      checkout_token: checkoutToken,
      checkout_url: `/payment-checkout?token=${checkoutToken}`,
      payment_id: operation.paymentId,
      provider: operation.provider,
    },
  }
  // This is the server-side equivalent of the sample "Send money" page:
  // checkout allocation stays in the panel, while the merchant receives a
  // signed payment.created event at its configured outbound webhook.
  await dispatchPaymentCreatedWebhook(session, operation.paymentId, wallet.paymentMethodCode ?? requestedMethod)
  await db.from('payment_idempotency_keys').insert({ scope: link?.merchant_id ?? 'public', idempotency_key: idem, operation: 'create', payment_transaction_id: operation.paymentId, response_status: 201, response_payload: response })
  return c.json(response, 201)
})

payRoutes.get('/session/token/:token', async (c) => {
  const token = c.req.param('token')
  if (!/^[a-f0-9]{64}$/i.test(token)) return c.json({ error: 'not_found' }, 404)
  const hash = createHash('sha256').update(token).digest('hex')
  const { data: session } = await db.from('checkout_sessions').select('*').eq('checkout_token_hash', hash).maybeSingle()
  if (!session) return c.json({ error: 'not_found' }, 404)
  return c.json({ session: publicSession(session) })
})

payRoutes.get('/session/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'not_found' }, 404)
  const { data: session } = await db
    .from('checkout_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!session) return c.json({ error: 'not_found' }, 404)
  return c.json({ session: publicSession(session) })
})

// Latest stored USD/EGP rate, for the checkout page to show a live EGP
// estimate while the customer is still typing a USD amount. Read-only,
// public — the rate itself carries no sensitive information.
payRoutes.get('/rate', async (c) => {
  const pair = c.req.query('pair') === 'USDT/EGP' ? 'USDT/EGP' : 'USD/EGP'
  const { data } = await db.from('exchange_rates').select('currency_pair, rate, fetched_at').eq('currency_pair', pair).order('fetched_at', { ascending: false }).limit(1).maybeSingle()
  if (!data?.rate) return c.json({ error: 'rate_unavailable' }, 404)
  return c.json({ pair: data.currency_pair, rate: Number(data.rate), fetched_at: data.fetched_at })
})

const CHECKOUT_PROOF_BUCKET = 'pop'
const CHECKOUT_PROOF_PREFIX = 'checkout-proofs/'

// Customer-submitted proof, added on top of the auto wallet-assignment flow
// above: the customer still transfers to the wallet Binance/NGPay allocated,
// then uploads a screenshot here so the session surfaces as a reviewable
// item in All Transactions instead of relying only on automatic SMS
// matching. No auth — this is the public checkout flow — so it is scoped
// tightly to one existing, still-open session.
payRoutes.post('/session/:id/proof', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'not_found' }, 404)
  const { data: session } = await db.from('checkout_sessions').select('*').eq('id', id).maybeSingle()
  if (!session) return c.json({ error: 'not_found' }, 404)
  if (!['pending', 'processing'].includes(String(session.status))) return c.json({ error: 'session_not_open' }, 409)
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) return c.json({ error: 'session_expired' }, 410)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  const note = typeof form?.get('note') === 'string' ? String(form.get('note')).slice(0, 500) : null
  if (!(file instanceof File) || file.size < 1) return c.json({ error: 'proof_file_required' }, 400)
  if (file.size > 10 * 1024 * 1024) return c.json({ error: 'proof_file_too_large' }, 400)
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) return c.json({ error: 'invalid_proof_type' }, 400)

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'proof'
  const path = `${CHECKOUT_PROOF_PREFIX}${id}/${Date.now()}-${safeName}`
  const { error: uploadError } = await db.storage.from(CHECKOUT_PROOF_BUCKET).upload(path, new Uint8Array(await file.arrayBuffer()), { contentType: file.type, upsert: false })
  if (uploadError) return c.json({ error: 'proof_upload_failed', detail: uploadError.message }, 500)
  const { data: pub } = db.storage.from(CHECKOUT_PROOF_BUCKET).getPublicUrl(path)

  const meta = (session.metadata ?? {}) as Record<string, unknown>
  const { data: updated, error } = await db
    .from('checkout_sessions')
    .update({
      status: session.status === 'pending' ? 'processing' : session.status,
      metadata: { ...meta, customer_proof_url: pub.publicUrl, customer_proof_note: note },
    })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error || !updated) return c.json({ error: 'db_error' }, 500)

  void notifyTelegram(
    `📎 إثبات دفع من العميل\nRef: <code>${session.reference}</code>\nAmount: ${session.amount} ${session.currency}\nProof: ${pub.publicUrl}`,
  )

  return c.json({ session: publicSession(updated) })
})
