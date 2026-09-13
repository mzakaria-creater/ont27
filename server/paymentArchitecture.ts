import { createHash } from 'node:crypto'
import { db } from './db.js'

export type PaymentProvider = 'mpgs' | 'fawry' | 'instapay' | 'mobile_wallet' | 'usdt_trc20' | 'bank_transfer'
export type PaymentOperation = 'create' | 'capture' | 'refund' | 'payout' | 'void' | 'query'

const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|cvv|cvc|card.?number|wallet.?number|account.?number/i

export function maskPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskPayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : maskPayload(item)]))
}

export function providerAdapter(method: string | null | undefined): PaymentProvider {
  const value = String(method ?? '').toLowerCase().replaceAll('-', '_')
  if (value.includes('mpgs')) return 'mpgs'
  if (value.includes('fawry')) return 'fawry'
  if (value.includes('insta')) return 'instapay'
  if (value.includes('usdt') || value.includes('trc20')) return 'usdt_trc20'
  if (value.includes('bank')) return 'bank_transfer'
  return 'mobile_wallet'
}

export function idempotencyKey(raw: string | null, fallback: string): string {
  const value = raw?.trim() || fallback
  return createHash('sha256').update(value).digest('hex')
}

export async function recordPaymentOperation(input: {
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
