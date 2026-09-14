import { db } from './db.js'

const EMAIL_ACTION = 'transaction.customer_approval_email_sent'

type ApprovedTransaction = {
  tx_id: number | string
  status?: unknown
  approved_by?: unknown
  approved_at?: unknown
  provider_confirmed?: boolean
}

/** Best-effort, idempotent customer notification. Email failure never rolls back approval. */
export async function notifyApprovedTransaction(tx: ApprovedTransaction): Promise<{ sent: boolean; reason?: string; recipient?: string }> {
  const txId = String(tx.tx_id)
  if (!['PAID', 'APPROVED'].includes(String(tx.status ?? 'PAID').toUpperCase())) {
    return { sent: false, reason: 'transaction_not_approved' }
  }

  const { data: alreadySent, error: lookupError } = await db
    .from('audit_log')
    .select('id')
    .eq('action', EMAIL_ACTION)
    .eq('entity', 'maven_transactions')
    .eq('entity_id', txId)
    .limit(1)
    .maybeSingle()
  if (lookupError) console.error('approval email idempotency lookup failed', { txId, error: lookupError.message })
  if (alreadySent) return { sent: true, reason: 'already_sent' }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!supabaseUrl || !serviceKey) {
    console.warn('customer approval email skipped: Supabase server credentials are not configured', { txId })
    return { sent: false, reason: 'email_not_configured' }
  }

  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/transaction-approval-email`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tx_id: Number(txId) }),
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok || result.ok !== true) {
      console.error('customer approval email function failed', { txId, status: response.status, error: result.error, detail: result.detail })
      return { sent: false, reason: String(result.error || 'email_provider_failed') }
    }

    const sent = Number(result.sent ?? 0)
    if (sent === 0) return { sent: false, reason: String(result.reason || 'no_matching_subscriptions') }
    const recipients = Array.isArray(result.results)
      ? result.results.map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).email ?? '') : '').filter(Boolean)
      : []
    const recipient = recipients[0]
    const { error: auditError } = await db.from('audit_log').insert({
      actor_type: 'system',
      actor_name: 'customer-approval-email',
      action: EMAIL_ACTION,
      entity: 'maven_transactions',
      entity_id: txId,
      after: {
        recipient: recipient ?? null,
        recipients,
        sent,
        provider: 'namecheap_private_email',
        provider_message_id: result.message_id || null,
        approved_by: tx.approved_by,
        approved_at: tx.approved_at,
        provider_confirmed: tx.provider_confirmed === true,
      },
    })
    if (auditError) console.error('customer approval email audit insert failed', { txId, error: auditError.message })
    return { sent: true, recipient }
  } catch (error) {
    console.error('customer approval email failed', { txId, error: error instanceof Error ? error.message : 'send_failed' })
    return { sent: false, reason: 'email_send_failed' }
  }
}
