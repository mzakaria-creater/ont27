import { Hono } from 'hono'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from './db.js'
import { sha256Hex } from './tokens.js'
import { maskPayload, providerAdapter } from './paymentArchitecture.js'

type GatewayEnv = { Variables: { merchantId: string; keyId: string; keyEnv: string } }
type Operation = 'capture' | 'refund' | 'payout' | 'void' | 'query'

const paymentView = 'id, public_id, merchant_id, master_merchant_id, sub_merchant_id, checkout_session_id, provider_reference, amount, currency, payment_method, gateway_status, transaction_status, business_status, settlement_status, reconciliation_status, failure_code, failure_message, refunded_amount, metadata, created_at, updated_at, paid_at, cancelled_at'

const merchantAuth = async (c: any, next: () => Promise<void>) => {
  const authorization = c.req.header('authorization') ?? ''
  const secret = c.req.header('x-api-secret')?.trim() || (authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '')
  if (!secret) return c.json({ error: 'unauthorized' }, 401)
  const { data: key } = await db.from('merchant_api_keys').select('id, merchant_id, environment, is_active, revoked_at, expires_at').eq('secret_hash', sha256Hex(secret)).maybeSingle()
  const valid = key && key.is_active && !key.revoked_at && (!key.expires_at || new Date(key.expires_at).getTime() > Date.now())
  if (!valid) return c.json({ error: 'unauthorized' }, 401)
  c.set('merchantId', key.merchant_id)
  c.set('keyId', key.id)
  c.set('keyEnv', key.environment)
  void db.from('merchant_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id)
  return next()
}

function idempotency(c: any): string {
  return c.req.header('idempotency-key')?.trim() || ''
}

function publicPayment(row: Record<string, any>) {
  return {
    id: row.id,
    payment_id: row.public_id,
    merchant_id: row.merchant_id,
    master_merchant_id: row.master_merchant_id,
    sub_merchant_id: row.sub_merchant_id,
    provider_reference: row.provider_reference,
    amount: row.amount,
    currency: row.currency,
    payment_method: row.payment_method,
    gateway_status: row.gateway_status,
    transaction_status: row.transaction_status,
    business_status: row.business_status,
    settlement_status: row.settlement_status,
    reconciliation_status: row.reconciliation_status,
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    refunded_amount: row.refunded_amount,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at,
    cancelled_at: row.cancelled_at,
  }
}

export const gatewayRoutes = new Hono<GatewayEnv>()
gatewayRoutes.use('*', merchantAuth)

gatewayRoutes.get('/', (c) => c.json({
  service: 'OnTarget Gateway API', version: 'v2', environment: c.get('keyEnv'),
  endpoints: {
    create: 'POST /api/v1/gateway/payments',
    retrieve: 'GET /api/v1/gateway/payments/:paymentId',
    operation: 'POST /api/v1/gateway/payments/:paymentId/operations',
    webhook: 'POST /api/v1/gateway/webhooks/:provider',
  },
}))

gatewayRoutes.post('/payments', async (c) => {
  const key = idempotency(c)
  if (!key) return c.json({ error: 'idempotency_key_required' }, 400)
  const body = await c.req.json().catch(() => null)
  const amount = Number(body?.amount)
  const currency = typeof body?.currency === 'string' ? body.currency.trim().toUpperCase() : 'EGP'
  const method = typeof body?.payment_method === 'string' ? body.payment_method.trim() : null
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return c.json({ error: 'invalid_amount' }, 400)
  if (!/^[A-Z]{3}$/.test(currency)) return c.json({ error: 'invalid_currency' }, 400)
  if (method && method.length > 80) return c.json({ error: 'invalid_payment_method' }, 400)

  const merchantId = c.get('merchantId')
  const { data: merchant } = await db.from('merchants').select('id, master_merchant_id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'merchant_not_found' }, 404)
  const publicId = typeof body?.payment_id === 'string' && /^[A-Za-z0-9_-]{4,80}$/.test(body.payment_id)
    ? body.payment_id : `OT-${cryptoRandomId()}`
  const provider = providerAdapter(method)
  const request = maskPayload({ amount, currency, payment_method: method, metadata: body?.metadata ?? {} })
  const { data, error } = await db.rpc('gateway_create_payment', {
    p_public_id: publicId, p_merchant_id: merchantId, p_master_merchant_id: merchant.master_merchant_id ?? null,
    p_sub_merchant_id: body?.sub_merchant_id == null ? null : Number(body.sub_merchant_id),
    p_checkout_session_id: body?.checkout_session_id ?? null, p_amount: amount, p_currency: currency,
    p_payment_method: method, p_provider: provider, p_idempotency_key: sha256Key(key), p_request_payload: request,
  })
  if (error || !data) return c.json({ error: 'payment_create_failed', detail: error?.message }, 500)
  const payload = data.response_payload?.payment ? publicPayment(data.response_payload.payment) : data.response_payload
  return c.json({ data: payload, idempotent: data.response_status !== 201 }, data.response_status === 201 ? 201 : 200)
})

gatewayRoutes.get('/payments/:paymentId', async (c) => {
  const { data, error } = await db.from('payment_transactions').select(paymentView).eq('public_id', c.req.param('paymentId')).eq('merchant_id', c.get('merchantId')).maybeSingle()
  if (error) return c.json({ error: 'internal_error' }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  const { data: operations } = await db.from('transaction_operations').select('id, operation_type, status, response_payload, error_code, created_at, completed_at').eq('payment_transaction_id', data.id).order('created_at', { ascending: true })
  return c.json({ data: publicPayment(data), operations: operations ?? [] })
})

gatewayRoutes.post('/payments/:paymentId/operations', async (c) => {
  const operationKey = idempotency(c)
  if (!operationKey) return c.json({ error: 'idempotency_key_required' }, 400)
  const body = await c.req.json().catch(() => null)
  const operation = body?.operation as Operation
  if (!['capture', 'refund', 'payout', 'void', 'query'].includes(operation)) return c.json({ error: 'invalid_operation' }, 400)
  const { data: payment } = await db.from('payment_transactions').select(paymentView).eq('public_id', c.req.param('paymentId')).eq('merchant_id', c.get('merchantId')).maybeSingle()
  if (!payment) return c.json({ error: 'not_found' }, 404)
  const idem = sha256Key(operationKey)
  const { data: existing } = await db.from('transaction_operations').select('id, status, response_payload').eq('payment_transaction_id', payment.id).eq('operation_type', operation).eq('idempotency_key', idem).maybeSingle()
  if (existing) return c.json({ data: existing.response_payload, idempotent: true })

  const amount = operation === 'refund' ? Number(body?.amount ?? payment.amount - Number(payment.refunded_amount ?? 0)) : Number(payment.amount)
  if (operation === 'refund' && (!Number.isFinite(amount) || amount <= 0 || amount > Number(payment.amount) - Number(payment.refunded_amount ?? 0))) return c.json({ error: 'invalid_refund_amount' }, 400)
  const now = new Date().toISOString()
  const update: Record<string, unknown> = {}
  if (operation === 'capture') Object.assign(update, { gateway_status: 'captured', transaction_status: 'paid', business_status: 'paid', paid_at: now })
  if (operation === 'payout') Object.assign(update, { gateway_status: 'processing', transaction_status: 'pending', business_status: 'unpaid' })
  if (operation === 'void') Object.assign(update, { gateway_status: 'cancelled', transaction_status: 'cancelled', business_status: 'cancelled', cancelled_at: now })
  if (operation === 'refund') {
    const refunded = Number(payment.refunded_amount ?? 0) + amount
    Object.assign(update, { refunded_amount: refunded, gateway_status: refunded >= Number(payment.amount) ? 'refunded' : 'captured', transaction_status: refunded >= Number(payment.amount) ? 'refunded' : 'partially_refunded', business_status: refunded >= Number(payment.amount) ? 'refunded' : 'partially_refunded' })
  }
  if (Object.keys(update).length) {
    const { error } = await db.from('payment_transactions').update(update).eq('id', payment.id)
    if (error) return c.json({ error: 'operation_update_failed' }, 500)
  }
  const response = { payment_id: payment.public_id, operation, status: operation === 'query' ? payment.transaction_status : 'succeeded', amount: operation === 'refund' ? amount : undefined }
  const { data: op, error: opError } = await db.from('transaction_operations').insert({ payment_transaction_id: payment.id, operation_type: operation, idempotency_key: idem, status: 'succeeded', request_payload: maskPayload(body ?? {}), response_payload: response, completed_at: now }).select('id').single()
  if (opError || !op) return c.json({ error: 'operation_record_failed' }, 500)
  await db.from('gateway_logs').insert({ payment_transaction_id: payment.id, transaction_operation_id: op.id, provider: providerAdapter(payment.payment_method), operation, request_payload: maskPayload(body ?? {}), response_payload: response, request_headers: {}, success: true, http_status: 200 })
  const { data: updated } = await db.from('payment_transactions').select(paymentView).eq('id', payment.id).single()
  return c.json({ data: publicPayment(updated ?? payment), operation: response }, 200)
})

gatewayRoutes.post('/webhooks/:provider', async (c) => {
  const raw = await c.req.text()
  const signature = c.req.header('x-gateway-signature') ?? ''
  const { data: merchant } = await db.from('merchants').select('callback_secret').eq('id', c.get('merchantId')).maybeSingle()
  if (!merchant?.callback_secret || !signature || !validSignature(raw, signature, merchant.callback_secret)) return c.json({ error: 'invalid_signature' }, 401)
  const body = JSON.parse(raw) as Record<string, any>
  const paymentId = typeof body.payment_id === 'string' ? body.payment_id : ''
  const providerStatus = typeof body.status === 'string' ? body.status.toLowerCase() : ''
  const { data: payment } = await db.from('payment_transactions').select(paymentView).eq('public_id', paymentId).eq('merchant_id', c.get('merchantId')).maybeSingle()
  if (!payment) return c.json({ error: 'not_found' }, 404)
  const update: Record<string, unknown> = { provider_reference: typeof body.provider_reference === 'string' ? body.provider_reference.slice(0, 160) : payment.provider_reference, gateway_status: providerStatus === 'paid' ? 'captured' : providerStatus === 'failed' ? 'failed' : 'processing', transaction_status: providerStatus === 'paid' ? 'paid' : providerStatus === 'failed' ? 'failed' : 'pending', business_status: providerStatus === 'paid' ? 'paid' : providerStatus === 'failed' ? 'unpaid' : 'unpaid', reconciliation_status: 'matched' }
  if (providerStatus === 'paid') update.paid_at = new Date().toISOString()
  await db.from('payment_transactions').update(update).eq('id', payment.id)
  await db.from('gateway_logs').insert({ payment_transaction_id: payment.id, provider: c.req.param('provider').slice(0, 40), operation: 'webhook', request_payload: maskPayload(body), response_payload: { accepted: true }, request_headers: {}, success: true, http_status: 200 })
  return c.json({ received: true })
})

function sha256Key(value: string) { return sha256Hex(value) }
function cryptoRandomId() { return randomBytes(12).toString('hex') }
function validSignature(raw: string, provided: string, secret: string) {
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(expected); const b = Buffer.from(provided.replace(/^sha256=/, ''))
  return a.length === b.length && timingSafeEqual(a, b)
}
