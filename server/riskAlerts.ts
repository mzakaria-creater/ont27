import { db } from './db.js'
import { sendTelegramAlert } from './notify.js'

const VELOCITY_WINDOW_MIN = Math.max(Number(process.env.HIGH_VELOCITY_WINDOW_MINUTES) || 10, 1)
const VELOCITY_THRESHOLD = Math.max(Number(process.env.HIGH_VELOCITY_TX_THRESHOLD) || 5, 2)
const VELOCITY_COOLDOWN_MIN = 30

// Wider window than the velocity check on purpose: a merchant's success
// rate needs enough settled transactions to be meaningful, not just
// whatever landed in the last 10 minutes.
const MERCHANT_SUCCESS_WINDOW_MIN = Math.max(Number(process.env.MERCHANT_SUCCESS_WINDOW_MINUTES) || 60, 10)
const MERCHANT_SUCCESS_MIN_SAMPLE = Math.max(Number(process.env.MERCHANT_SUCCESS_MIN_SAMPLE) || 10, 3)
const MERCHANT_SUCCESS_THRESHOLD_PCT = 40
const MERCHANT_SUCCESS_COOLDOWN_MIN = 60

type RiskAlertResult = { scanned: number; wrongful: number; velocity: number; merchant_low_success: number; sent: number; errors: string[] }
type RecentTx = { tx_id: number; ontarget_ref: string | null; status: string | null; amount: number | null; sender_name: string | null; sender_number: string | null; merchant: string | null; first_seen_at: string | null }

const esc = (value: unknown) => String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const phoneKey = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)

async function recentlyEmitted(action: string, entityId: string, since: string): Promise<boolean> {
  const { data, error } = await db.from('audit_log').select('id').eq('action', action).eq('entity', 'risk_alert').eq('entity_id', entityId).gte('created_at', since).limit(1)
  if (error) throw new Error(`alert dedupe: ${error.message}`)
  return Boolean(data?.length)
}

async function record(action: string, entityId: string, after: Record<string, unknown>) {
  const { error } = await db.from('audit_log').insert({
    actor_type: 'system', actor_name: 'risk-alert-producer', action,
    entity: 'risk_alert', entity_id: entityId, after,
  })
  if (error) throw new Error(`alert audit: ${error.message}`)
}

// Detection only. This function never updates a transaction, invokes a
// provider, approves, or declines anything.
export async function produceRiskAlerts(): Promise<RiskAlertResult> {
  const now = Date.now()
  const windowSince = new Date(now - VELOCITY_WINDOW_MIN * 60_000).toISOString()
  const cooldownSince = new Date(now - VELOCITY_COOLDOWN_MIN * 60_000).toISOString()
  const result: RiskAlertResult = { scanned: 0, wrongful: 0, velocity: 0, merchant_low_success: 0, sent: 0, errors: [] }
  const { data, error } = await db.from('maven_transactions')
    .select('tx_id, ontarget_ref, status, amount, sender_name, sender_number, merchant, first_seen_at')
    .gte('first_seen_at', windowSince).order('first_seen_at', { ascending: false }).limit(1000)
  if (error) throw new Error(`risk scan: ${error.message}`)
  const rows = (data ?? []) as RecentTx[]
  result.scanned = rows.length

  const declinedIds = rows.filter((row) => row.status === 'DECLINED').map((row) => row.tx_id)
  const evidence = new Set<number>()
  for (let index = 0; index < declinedIds.length; index += 200) {
    const { data: linked, error: linkedError } = await db.from('inbound_sms').select('consumed_by_tx_id').in('consumed_by_tx_id', declinedIds.slice(index, index + 200))
    if (linkedError) { result.errors.push(`wrongful evidence: ${linkedError.message}`); break }
    for (const item of linked ?? []) if (item.consumed_by_tx_id != null) evidence.add(Number(item.consumed_by_tx_id))
  }
  for (const row of rows.filter((item) => item.status === 'DECLINED' && evidence.has(item.tx_id))) {
    result.wrongful++
    const entityId = String(row.tx_id)
    try {
      if (await recentlyEmitted('telegram.wrongful_auto_decline', entityId, '1970-01-01T00:00:00Z')) continue
      const delivery = await sendTelegramAlert('wrongful_auto_decline', [
        '⚠️ <b>رفض مشبوه يحتاج مراجعة بشرية</b>',
        `TRX: <code>${esc(row.ontarget_ref ?? row.tx_id)}</code>`,
        `المبلغ: <b>${esc(row.amount)} EGP</b>`,
        `العميل: ${esc(row.sender_name)} · <code>${esc(row.sender_number)}</code>`,
        `التاجر: ${esc(row.merchant)}`,
        'السبب: المعاملة DECLINED مع وجود SMS مالي مرتبط بها. لم يغيّر النظام الحالة.',
      ].join('\n'))
      if (delivery.sent > 0) result.sent += delivery.sent
      await record('telegram.wrongful_auto_decline', entityId, { sent: delivery.sent, ok: delivery.ok, error: delivery.error ?? null })
    } catch (e) { result.errors.push(e instanceof Error ? e.message : 'wrongful_alert_failed') }
  }

  const byPhone = new Map<string, RecentTx[]>()
  for (const row of rows) {
    const key = phoneKey(row.sender_number)
    if (!key) continue
    byPhone.set(key, [...(byPhone.get(key) ?? []), row])
  }
  for (const [phone, transactions] of byPhone) {
    if (transactions.length < VELOCITY_THRESHOLD) continue
    result.velocity++
    try {
      if (await recentlyEmitted('telegram.high_velocity_sender', phone, cooldownSince)) continue
      const volume = transactions.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
      const delivery = await sendTelegramAlert('high_velocity_sender', [
        '🚨 <b>سرعة معاملات مرتفعة</b>',
        `الرقم: <code>${esc(phone)}</code>`,
        `المعاملات: <b>${transactions.length}</b> خلال ${VELOCITY_WINDOW_MIN} دقائق`,
        `إجمالي المبلغ: <b>${esc(volume)} EGP</b>`,
        'تنبيه للمراجعة فقط — لم يُنفّذ أي إجراء تلقائي.',
      ].join('\n'))
      if (delivery.sent > 0) result.sent += delivery.sent
      await record('telegram.high_velocity_sender', phone, { count: transactions.length, volume, sent: delivery.sent, ok: delivery.ok, error: delivery.error ?? null })
    } catch (e) { result.errors.push(e instanceof Error ? e.message : 'velocity_alert_failed') }
  }

  const successWindowSince = new Date(now - MERCHANT_SUCCESS_WINDOW_MIN * 60_000).toISOString()
  const successCooldownSince = new Date(now - MERCHANT_SUCCESS_COOLDOWN_MIN * 60_000).toISOString()
  const { data: successRows, error: successError } = await db.from('maven_transactions')
    .select('merchant, status')
    .gte('first_seen_at', successWindowSince)
    .in('status', ['PAID', 'APPROVED', 'DECLINED'])
    .not('merchant', 'is', null)
    .limit(5000)
  if (successError) {
    result.errors.push(`merchant success scan: ${successError.message}`)
  } else {
    const byMerchant = new Map<string, { settled: number; paid: number }>()
    for (const row of successRows ?? []) {
      const merchant = String(row.merchant ?? '').trim()
      if (!merchant) continue
      const stat = byMerchant.get(merchant) ?? { settled: 0, paid: 0 }
      stat.settled++
      if (row.status === 'PAID' || row.status === 'APPROVED') stat.paid++
      byMerchant.set(merchant, stat)
    }
    for (const [merchant, stat] of byMerchant) {
      if (stat.settled < MERCHANT_SUCCESS_MIN_SAMPLE) continue
      const rate = (stat.paid / stat.settled) * 100
      if (rate >= MERCHANT_SUCCESS_THRESHOLD_PCT) continue
      result.merchant_low_success++
      try {
        if (await recentlyEmitted('telegram.merchant_low_success', merchant, successCooldownSince)) continue
        const delivery = await sendTelegramAlert('merchant_low_success', [
          '📉 <b>تراجع نسبة نجاح التاجر</b>',
          `التاجر: <b>${esc(merchant)}</b>`,
          `نسبة النجاح: <b>${rate.toFixed(1)}%</b> (أقل من ${MERCHANT_SUCCESS_THRESHOLD_PCT}%)`,
          `المعاملات المكتملة: ${stat.settled} (ناجحة: ${stat.paid})`,
          `خلال آخر ${MERCHANT_SUCCESS_WINDOW_MIN} دقيقة`,
        ].join('\n'))
        if (delivery.sent > 0) result.sent += delivery.sent
        await record('telegram.merchant_low_success', merchant, { settled: stat.settled, paid: stat.paid, rate, sent: delivery.sent, ok: delivery.ok, error: delivery.error ?? null })
      } catch (e) { result.errors.push(e instanceof Error ? e.message : 'merchant_low_success_alert_failed') }
    }
  }
  return result
}
