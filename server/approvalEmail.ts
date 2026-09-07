import { db } from './db.js'

const APPROVAL_RECIPIENT = 'minafx2@gmail.com'

type ApprovedTransaction = {
  tx_id: number | string
  ontarget_ref?: unknown
  merchant_tx_reference?: unknown
  amount?: unknown
  currency?: unknown
  status?: unknown
  gateway?: unknown
  payment_method?: unknown
  sender_name?: unknown
  sender_number?: unknown
  master_merchant?: unknown
  merchant?: unknown
  sub_merchant?: unknown
  approved_by?: unknown
  approved_at?: unknown
  provider_confirmed?: boolean
}

function esc(value: unknown): string {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Best-effort, idempotent notification. Email failure never rolls back approval. */
export async function notifyApprovedTransaction(tx: ApprovedTransaction): Promise<{ sent: boolean; reason?: string }> {
  const txId = String(tx.tx_id)
  const { data: alreadySent, error: lookupError } = await db
    .from('audit_log')
    .select('id')
    .eq('action', 'transaction.approval_email_sent')
    .eq('entity', 'maven_transactions')
    .eq('entity_id', txId)
    .limit(1)
    .maybeSingle()
  if (lookupError) console.error('approval email idempotency lookup failed', { txId, error: lookupError.message })
  if (alreadySent) return { sent: true, reason: 'already_sent' }

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM || 'OnTarget <info@ontarget-egy.com>'
  if (!apiKey) {
    console.warn('approval email skipped: RESEND_API_KEY is not configured', { txId })
    return { sent: false, reason: 'email_not_configured' }
  }

  const reference = tx.ontarget_ref || tx.merchant_tx_reference || txId
  const amount = `${esc(tx.amount)} ${esc(tx.currency || 'EGP')}`
  const approvedAt = tx.approved_at || new Date().toISOString()
  const subject = `Transaction approved · ${String(reference)}`
  const html = `<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.5">
    <h2>Transaction approved</h2>
    <table cellpadding="7" cellspacing="0" style="border-collapse:collapse">
      <tr><td><b>Transaction ID</b></td><td>${esc(txId)}</td></tr>
      <tr><td><b>Reference</b></td><td>${esc(reference)}</td></tr>
      <tr><td><b>Amount</b></td><td>${amount}</td></tr>
      <tr><td><b>Status</b></td><td>${esc(tx.status || 'PAID')}</td></tr>
      <tr><td><b>Approved by</b></td><td>${esc(tx.approved_by)}</td></tr>
      <tr><td><b>Gateway</b></td><td>${esc(tx.gateway)}</td></tr>
      <tr><td><b>Payment method</b></td><td>${esc(tx.payment_method)}</td></tr>
      <tr><td><b>Sender</b></td><td>${esc(tx.sender_name)} · ${esc(tx.sender_number)}</td></tr>
      <tr><td><b>Merchant</b></td><td>${esc(tx.master_merchant)} / ${esc(tx.merchant)} / ${esc(tx.sub_merchant)}</td></tr>
      <tr><td><b>Approved at</b></td><td>${esc(approvedAt)}</td></tr>
      <tr><td><b>Provider confirmed</b></td><td>${tx.provider_confirmed ? 'Yes' : 'Panel/legacy action'}</td></tr>
    </table>
  </div>`

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [APPROVAL_RECIPIENT], subject, html }),
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      console.error('approval email provider failed', { txId, status: response.status, error: result.message || result.name })
      return { sent: false, reason: 'email_provider_failed' }
    }
    const { error: auditError } = await db.from('audit_log').insert({
      actor_type: 'system', actor_name: 'approval-email', action: 'transaction.approval_email_sent',
      entity: 'maven_transactions', entity_id: txId,
      after: { recipient: APPROVAL_RECIPIENT, provider: 'resend', provider_message_id: result.id || null, approved_by: tx.approved_by },
    })
    if (auditError) console.error('approval email audit insert failed', { txId, error: auditError.message })
    return { sent: true }
  } catch (error) {
    console.error('approval email failed', { txId, error: error instanceof Error ? error.message : 'send_failed' })
    return { sent: false, reason: 'email_send_failed' }
  }
}
