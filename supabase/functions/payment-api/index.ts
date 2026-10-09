// Supabase Edge Function port of the public checkout/payout API that lives
// in server/pay.ts (+ server/allocate.ts, server/paymentArchitecture.ts) on
// the Node side (Vercel + the Railway mirror). This is a deliberate,
// line-by-line port, not a rewrite from memory — the business logic (wallet
// allocation, idempotency, FX margin, webhook signing) is copied verbatim;
// only the runtime-specific primitives changed:
//   - db client: supabase-js via the npm: specifier, same panel-v2 project
//     (iwhjmhazcvctvipoasct) and the same tables — this is NOT a new data
//     layer, just a new place to run the same queries.
//   - node:crypto (createHash/createHmac/randomBytes) → Web Crypto helpers
//     in ../_shared/crypto.ts. panel-login-fallback already avoids node:
//     compat for the same reason; following that precedent here rather
//     than risking it on the riskiest (money-adjacent) function in the
//     project.
//   - CORS: every other edge function here is called server-to-server with
//     a service-role bearer token. This one is called directly from the
//     browser (the checkout/payout pages), same as the Node routes it
//     replaces have no auth check — so CORS + OPTIONS handling is new.
//
// NOT ported: nothing. All 8 routes from server/pay.ts are here. See the
// bottom of the file for the router (and its comment on path-stripping —
// Supabase only strips /functions/v1, not the function's own slug).
//
// Needs these secrets set on this Supabase project (`supabase secrets set`
// or the dashboard) — same values already configured on Vercel/Railway:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — auto-injected, already present
//   PANEL_JWT_SECRET                         — salts the visitor-hash digest
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID      — ops notifications (best-effort;
//                                               missing them just skips the
//                                               Telegram ping, same as today)

import { createClient } from 'npm:@supabase/supabase-js@2.45.0'
import { corsHeaders, handlePreflight, withCors } from '../_shared/cors.ts'
import { hmacSha256Hex, randomHex, sha256Hex } from '../_shared/crypto.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const SESSION_TTL_MIN = 15
// Mirrors server/pay.ts's CHECKOUT_USD_MARGIN_EGP exactly — must stay in
// sync with the Node copy, or customers would be quoted (GET /rate) a
// different rate than a session actually charges (POST /session) depending
// on which deployment handled each request.
const CHECKOUT_USD_MARGIN_EGP = 1

function json(body: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }))
}

// ---- ported from server/paymentArchitecture.ts ----

type PaymentProvider = 'mpgs' | 'fawry' | 'instapay' | 'mobile_wallet' | 'usdt_trc20' | 'bank_transfer'
type PaymentOperation = 'create' | 'capture' | 'refund' | 'payout' | 'void' | 'query'

const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|cvv|cvc|card.?number|wallet.?number|account.?number/i

function maskPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskPayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : maskPayload(item)]))
}

function providerAdapter(method: string | null | undefined): PaymentProvider {
  const value = String(method ?? '').toLowerCase().replaceAll('-', '_')
  if (value.includes('mpgs')) return 'mpgs'
  if (value.includes('fawry')) return 'fawry'
  if (value.includes('insta')) return 'instapay'
  if (value.includes('usdt') || value.includes('trc20')) return 'usdt_trc20'
  if (value.includes('bank')) return 'bank_transfer'
  return 'mobile_wallet'
}

async function idempotencyKey(raw: string | null, fallback: string): Promise<string> {
  const value = raw?.trim() || fallback
  return sha256Hex(value)
}

async function recordPaymentOperation(input: {
  publicId: string
  checkoutSessionId: string
  merchantId: string | null
  amount: number
  currency: string
  method: string | null
  operation: PaymentOperation
  idempotency: string
  request: Record<string, unknown>
}) {
  const provider = providerAdapter(input.method)
  const maskedRequest = maskPayload(input.request) as Record<string, unknown>
  const { data: payment, error: paymentError } = await db.from('payment_transactions').insert({
    public_id: input.publicId,
    merchant_id: input.merchantId,
    checkout_session_id: input.checkoutSessionId,
    amount: input.amount,
    currency: input.currency,
    payment_method: input.method,
    gateway_status: 'allocated',
    transaction_status: 'pending',
    business_status: 'unpaid',
    settlement_status: 'unsettled',
    reconciliation_status: 'unreconciled',
  }).select('id').single()
  if (paymentError || !payment) throw new Error(`payment transaction insert failed: ${paymentError?.message ?? 'unknown'}`)

  const started = Date.now()
  const { data: op, error: operationError } = await db.from('transaction_operations').insert({
    payment_transaction_id: payment.id,
    operation_type: input.operation,
    idempotency_key: input.idempotency,
    status: 'succeeded',
    request_payload: maskedRequest,
    response_payload: { public_id: input.publicId, provider },
    completed_at: new Date().toISOString(),
  }).select('id').single()
  if (operationError || !op) throw new Error(`payment operation insert failed: ${operationError?.message ?? 'unknown'}`)

  await db.from('gateway_logs').insert({
    payment_transaction_id: payment.id,
    transaction_operation_id: op.id,
    provider,
    operation: input.operation,
    request_payload: maskedRequest,
    response_payload: { public_id: input.publicId, status: 'pending' },
    request_headers: {},
    duration_ms: Date.now() - started,
    success: true,
  })
  return { paymentId: payment.id, provider }
}

// ---- ported from server/allocate.ts ----

interface AllocatedWallet {
  channelId: string
  channelName: string
  channelType: string
  currency: string
  walletNumber: string
  provider: string
  device: string
  deeplinkTemplate: string | null
  accountId?: string
  paymentMethodId?: string
  paymentMethodCode?: string
  paymentMethodName?: string
  allocations?: Array<{ walletNumber: string; amount: number; provider: string; device: string; accountId?: string }>
}

interface AllocationOptions {
  poolId?: string | null
  methodCodes?: string[]
  accountIds?: string[]
  amount?: number
  mode?: 'single_queue' | 'multi_wallet'
  multiWalletThreshold?: number | null
}

async function allocateWallet(currency: string, options: AllocationOptions = {}): Promise<AllocatedWallet | null> {
  if (options.poolId || (options.methodCodes && options.methodCodes.length) || (options.accountIds && options.accountIds.length)) {
    let accountsQuery = db
      .from('payment_accounts')
      .select('id, payment_method_id, account_number, device_name, label, current_balance, payment_methods!inner(method_code, method_name, channel_type)')
      .eq('is_active', true)
      .eq('currency', currency)
    if (options.poolId) accountsQuery = accountsQuery.eq('payment_pool_id', options.poolId)
    if (options.accountIds && options.accountIds.length) accountsQuery = accountsQuery.in('id', options.accountIds)
    const { data: accounts } = await accountsQuery
    const codes = new Set((options.methodCodes ?? []).map((code) => code.toUpperCase()))
    const candidates = (accounts ?? []).filter((account: any) => {
      const method = Array.isArray(account.payment_methods) ? account.payment_methods[0] : account.payment_methods
      return !codes.size || codes.has(String(method?.method_code ?? '').toUpperCase())
    })
    if (candidates.length) {
      const { data: open } = await db.from('checkout_sessions').select('metadata').eq('status', 'pending').gt('expires_at', new Date().toISOString())
      const load = new Map<string, number>()
      for (const session of open ?? []) {
        const number = (session.metadata as { wallet_number?: string } | null)?.wallet_number
        if (number) load.set(number, (load.get(number) ?? 0) + 1)
      }
      candidates.sort((a: any, b: any) => (load.get(a.account_number) ?? 0) - (load.get(b.account_number) ?? 0))
      const amount = Number(options.amount) || 0
      const multi = options.mode === 'multi_wallet' && amount > 0 && amount >= Number(options.multiWalletThreshold || 0) && candidates.length > 1
      const selected = multi ? candidates.slice(0, Math.min(3, candidates.length)) : candidates.slice(0, 1)
      const first = selected[0]
      const firstMethod = Array.isArray(first.payment_methods) ? first.payment_methods[0] : first.payment_methods
      const allocations = selected.map((account: any) => ({
        walletNumber: account.account_number,
        amount: Math.round((amount / selected.length) * 100) / 100,
        provider: String((Array.isArray(account.payment_methods) ? account.payment_methods[0] : account.payment_methods)?.method_code ?? 'wallet'),
        device: account.device_name ?? account.label ?? 'payment-account',
        accountId: account.id,
      }))
      return {
        channelId: '',
        channelName: firstMethod?.method_name ?? 'Payment account',
        channelType: firstMethod?.channel_type ?? 'payment_account',
        currency,
        walletNumber: first.account_number,
        provider: String(firstMethod?.method_code ?? 'wallet'),
        device: first.device_name ?? first.label ?? 'payment-account',
        deeplinkTemplate: null,
        accountId: first.id,
        paymentMethodId: first.payment_method_id,
        paymentMethodCode: firstMethod?.method_code,
        paymentMethodName: firstMethod?.method_name,
        allocations: multi ? allocations : undefined,
      }
    }
    return null
  }

  const { data: channel } = await db
    .from('local_deposit_channels')
    .select('id, display_name, channel_type, currency_code, config')
    .eq('active', true)
    .eq('currency_code', currency)
    .limit(1)
    .maybeSingle()
  if (!channel) return null

  const cfg = (channel.config ?? {}) as { devices?: string[]; deeplink_template?: string }
  const devices: string[] = cfg.devices ?? []
  if (!devices.length) return null

  const [{ data: wallets }, { data: statuses }, { data: open }] = await Promise.all([
    db.from('wallet_device_map')
      .select('to_account_number, device, provider, daily_limit')
      .in('device', devices),
    db.from('device_status').select('device, online, last_seen_at').in('device', devices),
    db.from('checkout_sessions')
      .select('metadata')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString()),
  ])
  if (!wallets?.length) return null

  const onlineDevices = new Set((statuses ?? []).filter((s: any) => s.online).map((s: any) => s.device))
  const load = new Map<string, number>()
  for (const s of open ?? []) {
    const num = (s.metadata as { wallet_number?: string } | null)?.wallet_number
    if (num) load.set(num, (load.get(num) ?? 0) + 1)
  }

  const candidates = wallets
    .filter((w: any) => onlineDevices.size === 0 || onlineDevices.has(w.device))
    .sort((a: any, b: any) => (load.get(a.to_account_number) ?? 0) - (load.get(b.to_account_number) ?? 0))
  const pick = candidates[0] ?? wallets[0]

  return {
    channelId: channel.id,
    channelName: channel.display_name,
    channelType: channel.channel_type,
    currency: channel.currency_code,
    walletNumber: pick.to_account_number,
    provider: pick.provider,
    device: pick.device,
    deeplinkTemplate: cfg.deeplink_template ?? null,
  }
}

// ---- ported from server/notify.ts (notifyTelegram only — pay.ts doesn't
// use sendTelegramAlert or notifyMerchantWebhook) ----

async function notifyTelegram(text: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID')
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

// ---- ported from server/pay.ts ----

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
  allowed_account_ids?: string[] | null
  checkout_token_hash?: string | null
}

async function merchantIdentity(merchantId: string | null | undefined) {
  if (!merchantId) return { merchantMid: null, masterMid: null }
  const { data: merchant } = await db.from('merchants').select('"MID", master_merchant_id').eq('id', merchantId).maybeSingle()
  if (!merchant) return { merchantMid: null, masterMid: null }
  const { data: master } = merchant.master_merchant_id
    ? await db.from('master_merchants').select('mid').eq('id', merchant.master_merchant_id).maybeSingle()
    : { data: null }
  return { merchantMid: (merchant as any).MID ?? null, masterMid: master?.mid ?? null }
}

function linkUsable(link: LinkRow): string | null {
  if (!link.active) return 'link_disabled'
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'link_expired'
  if (link.max_uses !== null && link.use_count >= link.max_uses) return 'link_exhausted'
  return null
}

async function visitorDigest(req: Request): Promise<string | null> {
  const salt = Deno.env.get('PANEL_JWT_SECRET')
  if (!salt) return null
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? ''
  const ua = req.headers.get('user-agent') ?? ''
  if (!ip && !ua) return null
  const day = new Date().toISOString().slice(0, 10)
  return (await sha256Hex(`${salt}|${day}|${ip}|${ua}`)).slice(0, 32)
}

async function recordOpen(link: { id: string; short_code: string }, blockedReason: string | null, req: Request): Promise<void> {
  try {
    await db.from('payment_link_opens').insert({
      link_id: link.id,
      short_code: link.short_code,
      visitor_hash: await visitorDigest(req),
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
  const signature = endpoint.signing_secret ? `sha256=${await hmacSha256Hex(endpoint.signing_secret, raw)}` : ''
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

function publicSession(s: Record<string, any>) {
  const meta = (s.metadata ?? {}) as Record<string, unknown>
  const expired = s.status === 'pending' && s.expires_at && new Date(s.expires_at as string).getTime() < Date.now()
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

async function findLinkByCodeOrToken(table: 'payment_links' | 'payout_links', supplied: string) {
  const tokenHash = /^[a-f0-9]{64}$/i.test(supplied) ? await sha256Hex(supplied) : null
  let query = db.from(table).select('*')
  query = tokenHash ? query.eq('checkout_token_hash', tokenHash) : query.eq('short_code', supplied)
  return query.maybeSingle()
}

// -- GET /link/:code --
async function handleGetLink(code: string, req: Request): Promise<Response> {
  const { data: link } = await findLinkByCodeOrToken('payment_links', code)
  if (!link) return json({ error: 'link_not_found' }, 404)
  const typedLink = link as LinkRow
  const unusable = linkUsable(typedLink)
  await recordOpen(typedLink, unusable, req)
  if (unusable) return json({ error: unusable }, 410)
  const identity = await merchantIdentity(typedLink.merchant_id)
  return json({
    link: {
      short_code: typedLink.short_code,
      title: typedLink.title,
      amount_mode: typedLink.amount_mode,
      amount: typedLink.amount,
      min_amount: typedLink.min_amount,
      max_amount: typedLink.max_amount,
      currency: typedLink.currency,
      client_name: typedLink.client_name ?? null,
      client_reference: typedLink.client_reference ?? null,
      return_url: typedLink.return_url ?? null,
      payment_method_codes: typedLink.payment_method_codes ?? [],
      allocation_mode: typedLink.allocation_mode ?? 'single_queue',
      multi_wallet_threshold: typedLink.multi_wallet_threshold ?? null,
      require_name: typedLink.require_name === true,
      merchant_mid: identity.merchantMid,
      master_mid: identity.masterMid,
    },
  })
}

// -- POST /session --
async function handleCreateSession(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)
  const requestIdempotency = req.headers.get('idempotency-key')?.trim() || (typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '')
  if (!requestIdempotency) return json({ error: 'idempotency_key_required' }, 400)
  const code = typeof body?.code === 'string' ? body.code.trim() : null
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : null
  const requestedMethod = typeof body?.payment_method_code === 'string' ? body.payment_method_code.trim().toUpperCase() : null
  const myhfmAccount = typeof body?.myhfm_account === 'string' ? body.myhfm_account.trim().slice(0, 60) : ''
  const rawAmount = Number(body?.amount)

  if (!/^01[0-9]{9}$/.test(phone)) return json({ error: 'invalid_phone' }, 400)

  let link: LinkRow | null = null
  if (code) {
    const { data } = await findLinkByCodeOrToken('payment_links', code)
    if (!data) return json({ error: 'link_not_found' }, 404)
    const unusable = linkUsable(data as LinkRow)
    if (unusable) return json({ error: unusable }, 410)
    link = data as LinkRow
  }

  if (link?.require_name && !name) return json({ error: 'name_required' }, 400)
  const isHfmLink = (link?.client_name ?? '').toLowerCase().includes('hfm')
  if (isHfmLink && !myhfmAccount) return json({ error: 'myhfm_account_required' }, 400)

  let currency = link?.currency ?? 'EGP'
  let amount = link?.amount_mode === 'fixed' ? Number(link.amount) : rawAmount
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'invalid_amount' }, 400)
  amount = Math.round(amount * 100) / 100
  const idem = await idempotencyKey(requestIdempotency, `${phone}:${amount}:${currency}`)
  const { data: previous } = await db.from('payment_idempotency_keys').select('response_status, response_payload').eq('scope', link?.merchant_id ?? 'public').eq('idempotency_key', idem).eq('operation', 'create').gt('expires_at', new Date().toISOString()).maybeSingle()
  if (previous?.response_payload) return json(previous.response_payload, previous.response_status === 201 ? 201 : 200)
  if (link?.amount_mode === 'open') {
    if (link.min_amount !== null && amount < link.min_amount) return json({ error: 'amount_below_min', min: link.min_amount }, 400)
    if (link.max_amount !== null && amount > link.max_amount) return json({ error: 'amount_above_max', max: link.max_amount }, 400)
  }

  let usdAmount: number | null = null
  let fxRate: number | null = null
  if (currency === 'USD') {
    const { data: rateRow } = await db.from('exchange_rates').select('rate').eq('currency_pair', 'USD/EGP').order('fetched_at', { ascending: false }).limit(1).maybeSingle()
    if (!rateRow?.rate || !(Number(rateRow.rate) > 0)) return json({ error: 'rate_unavailable' }, 503)
    fxRate = Number(rateRow.rate) + CHECKOUT_USD_MARGIN_EGP
    usdAmount = amount
    amount = Math.round(amount * fxRate * 100) / 100
    currency = 'EGP'
  }

  const allowedMethods = (link?.payment_method_codes ?? []).map((method) => method.toUpperCase())
  if (requestedMethod && allowedMethods.length && !allowedMethods.includes(requestedMethod)) {
    return json({ error: 'payment_method_not_allowed' }, 400)
  }

  const wallet = await allocateWallet(currency, {
    poolId: link?.wallet_pool_id,
    methodCodes: requestedMethod ? [requestedMethod] : allowedMethods,
    accountIds: link?.allowed_account_ids ?? undefined,
    amount,
    mode: link?.allocation_mode,
    multiWalletThreshold: link?.multi_wallet_threshold,
  })
  if (!wallet) return json({ error: 'no_channel_available' }, 503)

  if (link) {
    const { data: used, error } = await db.rpc('use_payment_link', { p_link_id: link.id })
    if (error || used === null) return json({ error: 'link_exhausted' }, 410)
  }

  const reference = `OT-${randomHex(5).toUpperCase()}`
  const checkoutToken = randomHex(32)
  const checkoutTokenHash = await sha256Hex(checkoutToken)
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
      local_deposit_channel_id: wallet.channelId || null,
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
        myhfm_account: myhfmAccount || null,
      },
      checkout_token_hash: checkoutTokenHash,
    })
    .select('*')
    .single()
  if (error || !session) {
    console.error('session insert failed:', error?.message)
    return json({ error: 'session_create_failed' }, 500)
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
  await dispatchPaymentCreatedWebhook(session, operation.paymentId, wallet.paymentMethodCode ?? requestedMethod)
  await db.from('payment_idempotency_keys').insert({ scope: link?.merchant_id ?? 'public', idempotency_key: idem, operation: 'create', payment_transaction_id: operation.paymentId, response_status: 201, response_payload: response })
  return json(response, 201)
}

// -- GET /session/token/:token --
async function handleGetSessionByToken(token: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/i.test(token)) return json({ error: 'not_found' }, 404)
  const hash = await sha256Hex(token)
  const { data: session } = await db.from('checkout_sessions').select('*').eq('checkout_token_hash', hash).maybeSingle()
  if (!session) return json({ error: 'not_found' }, 404)
  return json({ session: publicSession(session) })
}

// -- GET /session/:id --
async function handleGetSessionById(id: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'not_found' }, 404)
  const { data: session } = await db.from('checkout_sessions').select('*').eq('id', id).maybeSingle()
  if (!session) return json({ error: 'not_found' }, 404)
  return json({ session: publicSession(session) })
}

// -- GET /rate --
async function handleGetRate(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const pair = url.searchParams.get('pair') === 'USDT/EGP' ? 'USDT/EGP' : 'USD/EGP'
  const { data } = await db.from('exchange_rates').select('currency_pair, rate, fetched_at').eq('currency_pair', pair).order('fetched_at', { ascending: false }).limit(1).maybeSingle()
  if (!data?.rate) return json({ error: 'rate_unavailable' }, 404)
  const raw = Number(data.rate)
  return json({
    pair: data.currency_pair,
    rate: raw + CHECKOUT_USD_MARGIN_EGP,
    raw_rate: raw,
    buy_rate: raw + CHECKOUT_USD_MARGIN_EGP,
    sell_rate: raw - CHECKOUT_USD_MARGIN_EGP,
    fetched_at: data.fetched_at,
  })
}

const CHECKOUT_PROOF_BUCKET = 'pop'
const CHECKOUT_PROOF_PREFIX = 'checkout-proofs/'

// -- POST /session/:id/proof --
async function handleUploadProof(id: string, req: Request): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'not_found' }, 404)
  const { data: session } = await db.from('checkout_sessions').select('*').eq('id', id).maybeSingle()
  if (!session) return json({ error: 'not_found' }, 404)
  if (!['pending', 'processing'].includes(String(session.status))) return json({ error: 'session_not_open' }, 409)
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) return json({ error: 'session_expired' }, 410)

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const note = typeof form?.get('note') === 'string' ? String(form.get('note')).slice(0, 500) : null
  if (!(file instanceof File) || file.size < 1) return json({ error: 'proof_file_required' }, 400)
  if (file.size > 10 * 1024 * 1024) return json({ error: 'proof_file_too_large' }, 400)
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) return json({ error: 'invalid_proof_type' }, 400)

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'proof'
  const path = `${CHECKOUT_PROOF_PREFIX}${id}/${Date.now()}-${safeName}`
  const { error: uploadError } = await db.storage.from(CHECKOUT_PROOF_BUCKET).upload(path, new Uint8Array(await file.arrayBuffer()), { contentType: file.type, upsert: false })
  if (uploadError) return json({ error: 'proof_upload_failed', detail: uploadError.message }, 500)
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
  if (error || !updated) return json({ error: 'db_error' }, 500)

  void notifyTelegram(
    `📎 إثبات دفع من العميل\nRef: <code>${session.reference}</code>\nAmount: ${session.amount} ${session.currency}\nProof: ${pub.publicUrl}`,
  )

  return json({ session: publicSession(updated) })
}

interface PayoutLinkRow {
  id: string
  short_code: string
  checkout_token_hash: string | null
  title: string | null
  client_name: string | null
  currency: string
  amount_mode: 'open' | 'fixed'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
  active: boolean
  expires_at: string | null
  max_uses: number | null
  use_count: number
}

function payoutLinkUsable(link: PayoutLinkRow): string | null {
  if (!link.active) return 'link_disabled'
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'link_expired'
  if (link.max_uses !== null && link.use_count >= link.max_uses) return 'link_exhausted'
  return null
}

// -- GET /payout-link/:code --
async function handleGetPayoutLink(code: string): Promise<Response> {
  const { data: link } = await findLinkByCodeOrToken('payout_links', code)
  if (!link) return json({ error: 'link_not_found' }, 404)
  const typedLink = link as PayoutLinkRow
  const unusable = payoutLinkUsable(typedLink)
  if (unusable) return json({ error: unusable }, 410)
  return json({
    link: {
      short_code: typedLink.short_code,
      title: typedLink.title,
      client_name: typedLink.client_name,
      currency: typedLink.currency,
      amount_mode: typedLink.amount_mode,
      amount: typedLink.amount,
      min_amount: typedLink.min_amount,
      max_amount: typedLink.max_amount,
    },
  })
}

// -- POST /payout-session --
async function handleCreatePayoutSession(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null)
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  const myhfmAccount = typeof body?.myhfm_account === 'string' ? body.myhfm_account.trim().slice(0, 60) : ''
  const receiverName = typeof body?.receiver_name === 'string' ? body.receiver_name.trim().slice(0, 120) : null
  const receiverWallet = typeof body?.receiver_wallet === 'string' ? body.receiver_wallet.replace(/\D/g, '') : ''
  const receiverMethod = typeof body?.receiver_method === 'string' ? body.receiver_method.trim().slice(0, 40) : null
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : null
  const rawAmount = Number(body?.amount)

  if (!code) return json({ error: 'link_not_found' }, 404)
  if (!myhfmAccount) return json({ error: 'myhfm_account_required' }, 400)
  if (!/^01[0-9]{9}$/.test(receiverWallet)) return json({ error: 'invalid_wallet' }, 400)

  const { data: link } = await findLinkByCodeOrToken('payout_links', code)
  if (!link) return json({ error: 'link_not_found' }, 404)
  const typedLink = link as PayoutLinkRow
  const unusable = payoutLinkUsable(typedLink)
  if (unusable) return json({ error: unusable }, 410)

  let amount = typedLink.amount_mode === 'fixed' ? Number(typedLink.amount) : rawAmount
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'invalid_amount' }, 400)
  amount = Math.round(amount * 100) / 100
  if (typedLink.amount_mode === 'open') {
    if (typedLink.min_amount !== null && amount < typedLink.min_amount) return json({ error: 'amount_below_min', min: typedLink.min_amount }, 400)
    if (typedLink.max_amount !== null && amount > typedLink.max_amount) return json({ error: 'amount_above_max', max: typedLink.max_amount }, 400)
  }

  const reference = `OP-${randomHex(5).toUpperCase()}`
  const { data: request, error } = await db
    .from('payout_link_requests')
    .insert({
      payout_link_id: typedLink.id,
      reference,
      myhfm_account: myhfmAccount,
      receiver_name: receiverName,
      receiver_wallet: receiverWallet,
      receiver_method: receiverMethod,
      amount,
      currency: typedLink.currency,
      note,
      status: 'pending',
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: req.headers.get('user-agent') ?? null,
    })
    .select('id, reference, amount, currency, status, created_at')
    .single()
  if (error || !request) {
    console.error('payout_link_requests insert failed:', error?.message)
    return json({ error: 'request_create_failed' }, 500)
  }

  await db.from('payout_links').update({ use_count: typedLink.use_count + 1, updated_at: new Date().toISOString() }).eq('id', typedLink.id)

  void notifyTelegram(
    `🟠 طلب سحب جديد من عميل\nRef: <code>${reference}</code>\nAmount: ${amount} ${typedLink.currency}\nWallet: <code>${receiverWallet}</code>\nMYHFM: <code>${myhfmAccount}</code>\nيحتاج مراجعة يدوية قبل التنفيذ.`,
  )

  return json({ request }, 201)
}

// ---- router ----
// Invoke URL shape: https://<ref>.supabase.co/functions/v1/payment-api/<rest>
// Supabase strips only the /functions/v1 prefix before invoking — the
// function's own slug (/payment-api) is still part of req.url's pathname,
// confirmed empirically (an earlier version returned the raw pathname in
// its 404 body: "/payment-api/rate", not "/rate").

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  try {
    const { pathname } = new URL(req.url)
    const path = pathname.replace(/^\/payment-api/, '') || '/'
    const method = req.method

    let m: RegExpMatchArray | null

    if (method === 'GET' && (m = path.match(/^\/link\/([^/]+)$/))) return await handleGetLink(decodeURIComponent(m[1]), req)
    if (method === 'POST' && path === '/session') return await handleCreateSession(req)
    if (method === 'GET' && (m = path.match(/^\/session\/token\/([^/]+)$/))) return await handleGetSessionByToken(m[1])
    if (method === 'GET' && (m = path.match(/^\/session\/([^/]+)$/))) return await handleGetSessionById(m[1])
    if (method === 'GET' && path === '/rate') return await handleGetRate(req)
    if (method === 'POST' && (m = path.match(/^\/session\/([^/]+)\/proof$/))) return await handleUploadProof(m[1], req)
    if (method === 'GET' && (m = path.match(/^\/payout-link\/([^/]+)$/))) return await handleGetPayoutLink(decodeURIComponent(m[1]))
    if (method === 'POST' && path === '/payout-session') return await handleCreatePayoutSession(req)

    return json({ error: 'not_found' }, 404)
  } catch (error) {
    console.error('payment-api unhandled error:', error)
    return json({ error: 'internal_error' }, 500)
  }
})
