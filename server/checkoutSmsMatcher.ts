import { createHash } from 'node:crypto'
import { db } from './db.js'

// Resolves checkout_sessions (server/pay.ts + supabase/functions/payment-api)
// the same way server/smsMatcher.ts resolves maven_transactions: match an
// incoming deposit SMS to an open transaction and auto-approve. Confirmed
// live before this existed: every checkout_sessions row was stuck at
// pending/processing or had silently expired -- none had ever reached
// approved/declined, because nothing watched for the matching SMS at all.
//
// Deliberately NOT a fork of smsMatcher.ts's richer heuristics (balance
// continuity, name matching, embedded-phone parsing, network-provider SMS
// detection) -- those exist to resolve ambiguity in Maven's feed where the
// receiving transaction isn't already known precisely. A checkout session
// already knows its exact wallet and amount, because this app allocated
// that wallet and told the customer that exact amount; the only thing that
// needs resolving is "is there exactly one open session this SMS could be,"
// so an exact match + uniqueness + a bounded time window is the whole rule.
//
// Auto-APPROVE only, same philosophy as Maven's matcher: it never auto-
// declines. An unmatched session simply expires on its own TTL, the same
// way an unmatched Maven PENDING row just sits PENDING for manual review.
//
// inbound_sms.claimed_by_checkout_session_id (not the maven_transaction_id/
// matched_transaction_id/consumed_by_tx_id columns, which are keyed to
// Maven's own external tx_id lineage) marks an SMS as used here, and
// smsMatcher.ts's own candidate query excludes rows this matcher already
// claimed -- the two matchers partition the same inbound_sms pool instead
// of racing over it.

const phone = (value: unknown): string => {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}
const cents = (value: unknown): number => Math.round(Number(value) * 100)

interface CandidateSms {
  id: number
  amount: number | null
  sender_name: string | null
  sender_number: string | null
  received_at: string | null
  receiver_number: string | null
  wallet_number: string | null
  confirmed_wallet_number: string | null
}
interface CandidateSession {
  id: string
  reference: string | null
  amount: number | null
  currency: string | null
  status: string
  created_at: string
  expires_at: string | null
  metadata: Record<string, unknown> | null
}

const receivingWallet = (sms: CandidateSms): string | null => sms.confirmed_wallet_number ?? sms.wallet_number ?? sms.receiver_number

// A little grace past the session's own expiry: the transfer can complete
// (and its SMS arrive) a few minutes after the countdown hits zero even
// when the customer started it in time.
const EXPIRY_GRACE_MS = 5 * 60_000

export interface CheckoutSmsRepairResult {
  scannedSms: number
  scannedSessions: number
  matched: number
  skippedAmbiguous: number
  errors: string[]
}

export async function repairCheckoutSmsMatches(apply: boolean, scanLimit = 500): Promise<CheckoutSmsRepairResult> {
  const result: CheckoutSmsRepairResult = { scannedSms: 0, scannedSessions: 0, matched: 0, skippedAmbiguous: 0, errors: [] }
  const limit = Math.min(Math.max(scanLimit, 1), 1000)

  const [{ data: smsData, error: smsError }, { data: sessionData, error: sessionError }] = await Promise.all([
    db.from('inbound_sms')
      .select('id, amount, sender_name, sender_number, received_at, receiver_number, wallet_number, confirmed_wallet_number')
      .eq('sms_category', 'deposit')
      .is('consumed_by_tx_id', null)
      .is('matched_transaction_id', null)
      .is('maven_transaction_id', null)
      .is('claimed_by_checkout_session_id', null)
      .or('is_blocked.eq.false,is_blocked.is.null')
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    db.from('checkout_sessions')
      .select('id, reference, amount, currency, status, created_at, expires_at, metadata')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(limit),
  ])
  if (smsError) throw new Error(`checkout sms scan: ${smsError.message}`)
  if (sessionError) throw new Error(`checkout session scan: ${sessionError.message}`)

  const smsRows = (smsData ?? []) as CandidateSms[]
  // Wallets are EGP-denominated; a USD-quoted link's session row is already
  // converted to EGP at creation time (see payment-api's handleCreateSession),
  // so this is a defensive check, not an expected filter.
  const sessionRows = ((sessionData ?? []) as CandidateSession[]).filter((s) => (s.currency ?? 'EGP') === 'EGP')
  result.scannedSms = smsRows.length
  result.scannedSessions = sessionRows.length

  for (const sms of smsRows) {
    const wallet = phone(receivingWallet(sms))
    const amountCents = cents(sms.amount)
    if (!wallet || !Number.isFinite(amountCents)) continue
    const smsAt = Date.parse(String(sms.received_at ?? ''))
    if (!Number.isFinite(smsAt)) continue

    const candidates = sessionRows.filter((session) => {
      const meta = (session.metadata ?? {}) as { wallet_number?: string }
      if (phone(meta.wallet_number) !== wallet) return false
      if (cents(session.amount) !== amountCents) return false
      const createdAt = Date.parse(session.created_at)
      const expiresAt = Date.parse(session.expires_at ?? session.created_at) + EXPIRY_GRACE_MS
      return Number.isFinite(createdAt) && smsAt >= createdAt && smsAt <= expiresAt
    })
    if (candidates.length === 0) continue
    if (candidates.length > 1) { result.skippedAmbiguous += 1; continue }

    const session = candidates[0]
    if (!apply) { result.matched += 1; continue }

    const now = new Date().toISOString()
    const meta = (session.metadata ?? {}) as Record<string, unknown>
    const { error: sessionUpdateError } = await db
      .from('checkout_sessions')
      .update({
        status: 'approved',
        paid_at: now,
        metadata: { ...meta, matched_sms_id: sms.id, matched_sender_name: sms.sender_name ?? null, matched_sender_number: sms.sender_number ?? null },
      })
      .eq('id', session.id)
      .in('status', ['pending', 'processing'])
    if (sessionUpdateError) { result.errors.push(`session ${session.id}: ${sessionUpdateError.message}`); continue }

    const { error: smsClaimError } = await db
      .from('inbound_sms')
      .update({ claimed_by_checkout_session_id: session.id })
      .eq('id', sms.id)
      .is('claimed_by_checkout_session_id', null)
    if (smsClaimError) result.errors.push(`sms ${sms.id} claim: ${smsClaimError.message}`)

    // Mirrors the Gateway API's own "capture" operation vocabulary
    // (server/gateway.ts) exactly, so a merchant polling this payment
    // through either path sees the same status language.
    const { data: payment } = await db.from('payment_transactions').select('id').eq('checkout_session_id', session.id).maybeSingle()
    if (payment) {
      await db.from('payment_transactions').update({ gateway_status: 'captured', transaction_status: 'paid', business_status: 'paid', paid_at: now }).eq('id', payment.id)
      // idempotency_key is NOT NULL on this table (caught by a live dry-run
      // test before this ever ran for real — the original version omitted
      // it entirely). No user-supplied Idempotency-Key header exists for a
      // background match, so this derives a stable one from the session +
      // SMS pair: re-running the matcher against an already-captured pair
      // can never produce a second operation row.
      const operationIdempotencyKey = createHash('sha256').update(`checkout-sms-capture:${session.id}:${sms.id}`).digest('hex')
      await db.from('transaction_operations').insert({
        payment_transaction_id: payment.id,
        operation_type: 'capture',
        idempotency_key: operationIdempotencyKey,
        status: 'succeeded',
        request_payload: {},
        response_payload: { public_id: session.reference, matched_sms_id: sms.id },
        completed_at: now,
      })
    }

    await db.from('audit_log').insert({
      actor_type: 'system',
      actor_name: 'checkout-sms-matcher',
      action: 'checkout_session.auto_approve_sms_match',
      entity: 'checkout_sessions',
      entity_id: session.id,
      before: { status: session.status },
      after: { status: 'approved', sms_id: sms.id },
    })

    result.matched += 1
    // One session can't be claimed twice within the same run.
    const idx = sessionRows.indexOf(session)
    if (idx >= 0) sessionRows.splice(idx, 1)
  }

  return result
}
