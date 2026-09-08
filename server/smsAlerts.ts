import { db } from './db.js'
import { sendTelegramAlert } from './notify.js'

export type SmsAlertSeverity = 'freeze' | 'warning'

export interface SmsAlertRow {
  id: number
  received_at: string | null
  device_name: string | null
  provider: string | null
  sender_name: string | null
  receiver_number: string | null
  wallet_number: string | null
  amount: number | null
  balance_after: number | null
  sms_category: string | null
  message: string | null
  raw_sms: string | null
  sms_first_line: string | null
  severity: SmsAlertSeverity
  alert_reason: string
}

const FREEZE_RE = /freeze|frozen|blocked|suspend|suspended|wallet\s+closed|تجميد|مجمد|مجمّدة|موقوف|إيقاف|ايقاف|حظر|محظور|محظورة/i
const WARNING_RE = /warning|alert|declined|failed|insufficient|limit exceeded|تحذير|مرفوض|فشل|رصيد غير كاف|حد السحب|حد الإيداع/i
const esc = (value: unknown) => String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function messageOf(row: Record<string, unknown>) {
  return [row.message, row.raw_sms, row.sms_first_line].filter(Boolean).map(String).join('\n')
}

export function classifySmsAlert(row: Record<string, unknown>): SmsAlertRow | null {
  const message = messageOf(row)
  const severity: SmsAlertSeverity | null = FREEZE_RE.test(message) ? 'freeze' : WARNING_RE.test(message) ? 'warning' : null
  if (!severity) return null
  return {
    id: Number(row.id),
    received_at: row.received_at == null ? null : String(row.received_at),
    device_name: row.device_name == null ? null : String(row.device_name),
    provider: row.provider == null ? null : String(row.provider),
    sender_name: row.sender_name == null ? null : String(row.sender_name),
    receiver_number: row.receiver_number == null ? null : String(row.receiver_number),
    wallet_number: row.wallet_number == null ? null : String(row.wallet_number),
    amount: row.amount == null ? null : Number(row.amount),
    balance_after: row.balance_after == null ? null : Number(row.balance_after),
    sms_category: row.sms_category == null ? null : String(row.sms_category),
    message: row.message == null ? null : String(row.message),
    raw_sms: row.raw_sms == null ? null : String(row.raw_sms),
    sms_first_line: row.sms_first_line == null ? null : String(row.sms_first_line),
    severity,
    alert_reason: severity === 'freeze' ? 'Wallet freeze/blocked wording detected' : 'Financial warning wording detected',
  }
}

const SMS_ALERT_COLUMNS = 'id, received_at, device_name, provider, sender_name, receiver_number, wallet_number, amount, balance_after, sms_category, sms_first_line, raw_sms, message'

export async function listSmsAlerts(hours = 72, limit = 500): Promise<SmsAlertRow[]> {
  const { data, error } = await db.from('inbound_sms').select(SMS_ALERT_COLUMNS)
    .gte('received_at', new Date(Date.now() - hours * 3_600_000).toISOString())
    .order('received_at', { ascending: false, nullsFirst: false }).limit(limit)
  if (error) throw new Error(`sms alert scan: ${error.message}`)
  return (data ?? []).map((row) => classifySmsAlert(row as Record<string, unknown>)).filter(Boolean) as SmsAlertRow[]
}

async function alreadySent(id: number) {
  const { data, error } = await db.from('audit_log').select('id').eq('action', 'telegram.sms_wallet_freeze').eq('entity', 'inbound_sms').eq('entity_id', String(id)).limit(1)
  if (error) throw new Error(`sms alert dedupe: ${error.message}`)
  return Boolean(data?.length)
}

/** Detection only: it never changes a wallet or a transaction. */
export async function processWalletFreezeAlerts(): Promise<{ scanned: number; sent: number; errors: string[] }> {
  const alerts = await listSmsAlerts(24, 1000)
  const freezes = alerts.filter((row) => row.severity === 'freeze')
  let sent = 0
  const errors: string[] = []
  for (const alert of freezes) {
    try {
      if (await alreadySent(alert.id)) continue
      const delivery = await sendTelegramAlert('sms_wallet_freeze', [
        '🚨 <b>تنبيه تجميد محفظة</b>',
        `SMS ID: <code>${esc(alert.id)}</code>`,
        `المحفظة: <code>${esc(alert.wallet_number ?? alert.receiver_number)}</code>`,
        `الجهاز: <code>${esc(alert.device_name)}</code> · ${esc(alert.provider)}`,
        `الوقت: ${esc(alert.received_at)}`,
        esc((alert.message ?? alert.raw_sms ?? alert.sms_first_line ?? '').slice(0, 700)),
      ].join('\n'))
      sent += delivery.sent
      const { error } = await db.from('audit_log').insert({
        actor_type: 'system', actor_name: 'sms-alert-producer', action: 'telegram.sms_wallet_freeze', entity: 'inbound_sms', entity_id: String(alert.id),
        after: { severity: alert.severity, sent: delivery.sent, ok: delivery.ok, error: delivery.error ?? null },
      })
      if (error) throw new Error(`sms alert audit: ${error.message}`)
    } catch (error) { errors.push(error instanceof Error ? error.message : 'sms_freeze_alert_failed') }
  }
  return { scanned: freezes.length, sent, errors }
}
