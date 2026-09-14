import { db } from './db.js'

const EMAIL_ACTION = 'transaction.customer_approval_email_sent'
const DEFAULT_APP_URL = 'https://d.ontarget-egy.com'

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
  email?: unknown
  maven_raw_row?: unknown
}

function esc(value: unknown): string {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function rawValue(raw: unknown, names: string[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const wanted = new Set(names.map((name) => name.replace(/[^a-z0-9]/gi, '').toLowerCase()))
  return Object.entries(raw as Record<string, unknown>)
    .find(([key, value]) => wanted.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()) && value != null && String(value).trim())?.[1]
}

function validEmail(value: unknown): string | null {
  const email = String(value ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null
}

function money(value: unknown, currency: unknown): string {
  const amount = Number(value)
  const formatted = Number.isFinite(amount)
    ? new Intl.NumberFormat('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : String(value ?? '—')
  return `${formatted} ${String(currency || 'EGP').toUpperCase()}`
}

async function hydrateTransaction(input: ApprovedTransaction): Promise<ApprovedTransaction> {
  const { data, error } = await db
    .from('maven_transactions')
    .select('tx_id, ontarget_ref, merchant_tx_reference, amount, currency, status, gateway, payment_method, sender_name, sender_number, master_merchant, merchant, sub_merchant, approved_by, email, maven_raw_row, last_status_change')
    .eq('tx_id', input.tx_id)
    .maybeSingle()
  if (error) console.error('approval email transaction lookup failed', { txId: input.tx_id, error: error.message })
  return data ? { ...data, ...input, maven_raw_row: input.maven_raw_row ?? data.maven_raw_row, approved_at: input.approved_at ?? data.last_status_change } : input
}

/** Best-effort, idempotent customer notification. Email failure never rolls back approval. */
export async function notifyApprovedTransaction(input: ApprovedTransaction): Promise<{ sent: boolean; reason?: string; recipient?: string }> {
  const tx = await hydrateTransaction(input)
  const txId = String(tx.tx_id)
  const rawEmail = rawValue(tx.maven_raw_row, ['EmailAddress', 'UserEmail', 'Email'])
  const recipient = validEmail(tx.email) ?? validEmail(rawEmail)
  if (!recipient) {
    console.info('customer approval email skipped: transaction has no valid customer email', { txId })
    return { sent: false, reason: 'recipient_missing' }
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
  if (alreadySent) return { sent: true, reason: 'already_sent', recipient }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('customer approval email skipped: RESEND_API_KEY is not configured', { txId })
    return { sent: false, reason: 'email_not_configured', recipient }
  }

  const reference = tx.ontarget_ref || tx.merchant_tx_reference || txId
  const amount = money(tx.amount, tx.currency)
  const approvedAt = tx.approved_at || new Date().toISOString()
  const appUrl = (process.env.APP_URL || DEFAULT_APP_URL).replace(/\/$/, '')
  const detailsUrl = `${appUrl}/transactions/${encodeURIComponent(String(reference))}`
  const from = process.env.APPROVAL_EMAIL_FROM || 'OnTarget <info@ontarget-egy.com>'
  const subject = `Payment approved · ${amount} · #${String(reference)}`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f3f6fb;color:#172033;font-family:Arial,'Helvetica Neue',sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">Your payment of ${esc(amount)} has been approved.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6fb;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 32px rgba(24,39,75,.10)">
        <tr><td style="background:linear-gradient(135deg,#0b1736,#173b7a);padding:28px 34px;color:#fff">
          <div style="font-size:14px;font-weight:700;letter-spacing:1.4px">ONTARGET</div>
          <div style="margin-top:20px;width:48px;height:48px;line-height:48px;text-align:center;border-radius:50%;background:#22c55e;font-size:27px">✓</div>
          <h1 style="margin:14px 0 5px;font-size:27px;line-height:1.25">Payment approved</h1>
          <p style="margin:0;color:#dbe7ff;font-size:15px">تم اعتماد عملية الدفع بنجاح</p>
        </td></tr>
        <tr><td style="padding:30px 34px">
          <p style="margin:0 0 22px;font-size:16px;line-height:1.7">Hello${tx.sender_name ? ` ${esc(tx.sender_name)}` : ''}, your payment has been confirmed and approved.</p>
          <div style="background:#f7f9fc;border:1px solid #e5eaf2;border-radius:14px;padding:20px">
            <div style="font-size:13px;color:#667085;margin-bottom:6px">APPROVED AMOUNT · المبلغ المعتمد</div>
            <div style="font-size:30px;font-weight:800;color:#102a56">${esc(amount)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;font-size:14px">
              <tr><td style="padding:8px 0;color:#667085">Transaction ID</td><td align="right" style="padding:8px 0;font-weight:700">${esc(txId)}</td></tr>
              <tr><td style="padding:8px 0;color:#667085">Reference</td><td align="right" style="padding:8px 0;font-weight:700">${esc(reference)}</td></tr>
              <tr><td style="padding:8px 0;color:#667085">Status</td><td align="right" style="padding:8px 0"><span style="background:#dcfce7;color:#166534;padding:5px 10px;border-radius:999px;font-weight:700">APPROVED</span></td></tr>
              <tr><td style="padding:8px 0;color:#667085">Payment method</td><td align="right" style="padding:8px 0;font-weight:700">${esc(tx.payment_method || tx.gateway)}</td></tr>
              <tr><td style="padding:8px 0;color:#667085">Approved at</td><td align="right" style="padding:8px 0;font-weight:700">${esc(approvedAt)}</td></tr>
            </table>
          </div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 14px"><tr><td style="border-radius:10px;background:#155eef">
            <a href="${esc(detailsUrl)}" style="display:inline-block;padding:13px 24px;color:#fff;text-decoration:none;font-weight:700">View transaction · عرض العملية</a>
          </td></tr></table>
          <p dir="rtl" style="margin:20px 0 0;color:#475467;font-size:14px;line-height:1.8;text-align:right">تم تأكيد استلام دفعتك واعتماد العملية. احتفظ برقم المرجع للمتابعة.</p>
        </td></tr>
        <tr><td style="padding:20px 34px;background:#f8fafc;border-top:1px solid #e5eaf2;color:#98a2b3;font-size:12px;line-height:1.6">
          This is an automatic transaction notification from OnTarget. Please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': `customer-approval-${txId}`,
      },
      body: JSON.stringify({ from, to: [recipient], subject, html }),
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      console.error('customer approval email provider failed', { txId, status: response.status, error: result.message || result.name })
      return { sent: false, reason: 'email_provider_failed', recipient }
    }
    const { error: auditError } = await db.from('audit_log').insert({
      actor_type: 'system',
      actor_name: 'customer-approval-email',
      action: EMAIL_ACTION,
      entity: 'maven_transactions',
      entity_id: txId,
      after: { recipient, provider: 'resend', provider_message_id: result.id || null, approved_by: tx.approved_by },
    })
    if (auditError) console.error('customer approval email audit insert failed', { txId, error: auditError.message })
    return { sent: true, recipient }
  } catch (error) {
    console.error('customer approval email failed', { txId, error: error instanceof Error ? error.message : 'send_failed' })
    return { sent: false, reason: 'email_send_failed', recipient }
  }
}
