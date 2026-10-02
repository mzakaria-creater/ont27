import { db } from './db.js'
import { sendTelegramAlert } from './notify.js'

// Staff-facing Telegram notification on transaction decisions. There is no
// SMS-to-phone provider wired into this codebase and panel_users has no
// phone column, so Telegram (the channel already used for every other
// staff alert — risk, inactivity, wrongful-decline, etc.) is the real
// delivery path for "alert staff" requests. Best-effort: a delivery
// failure here must never affect the decision that already committed.

const esc = (value: unknown) => String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type DecisionTx = {
  tx_id: number | string
  ontarget_ref?: string | null
  amount?: number | null
  currency?: string | null
  merchant?: string | null
  sender_name?: string | null
  sender_number?: string | null
}

async function alreadyNotified(entityId: string, action: string): Promise<boolean> {
  const { data, error } = await db.from('audit_log').select('id').eq('action', action).eq('entity', 'risk_alert').eq('entity_id', entityId).limit(1)
  if (error) { console.error('tx decision alert dedupe failed:', error.message); return false }
  return Boolean(data?.length)
}

async function record(entityId: string, action: string, after: Record<string, unknown>) {
  const { error } = await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'tx-decision-alert', action, entity: 'risk_alert', entity_id: entityId, after })
  if (error) console.error('tx decision alert audit insert failed:', error.message)
}

export async function notifyTransactionDecision(
  kind: 'deposit' | 'payout',
  tx: DecisionTx,
  outcome: 'approved' | 'declined',
  actorName: string,
): Promise<void> {
  const entityId = `${kind}:${tx.tx_id}`
  const action = `telegram.${kind}_${outcome}`
  try {
    if (await alreadyNotified(entityId, action)) return
    const icon = outcome === 'approved' ? '✅' : '❌'
    const label = kind === 'deposit'
      ? (outcome === 'approved' ? 'تم اعتماد إيداع' : 'تم رفض إيداع')
      : (outcome === 'approved' ? 'تم تنفيذ سحب' : 'تم رفض طلب سحب')
    const delivery = await sendTelegramAlert(`${kind}_${outcome}`, [
      `${icon} <b>${label}</b>`,
      `TRX: <code>${esc(tx.ontarget_ref ?? tx.tx_id)}</code>`,
      `المبلغ: <b>${esc(tx.amount)} ${esc(tx.currency ?? 'EGP')}</b>`,
      tx.merchant ? `التاجر: ${esc(tx.merchant)}` : null,
      (tx.sender_name || tx.sender_number) ? `العميل: ${esc(tx.sender_name)} · <code>${esc(tx.sender_number)}</code>` : null,
      `بواسطة: ${esc(actorName)}`,
    ].filter(Boolean).join('\n'))
    await record(entityId, action, { outcome, actor: actorName, sent: delivery.sent, ok: delivery.ok, error: delivery.error ?? null })
  } catch (error) {
    console.error('transaction decision telegram alert failed:', { entityId, error: error instanceof Error ? error.message : error })
  }
}
