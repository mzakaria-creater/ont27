import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CircleDollarSign, LifeBuoy, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { playNotificationTone } from '../lib/notificationSounds'
import { supabase } from '../lib/supabase'

interface AlertRow { id: number; alert_type: string; message: string; created_at: string }
interface PopupAlert extends AlertRow {
  transactionRef: string | null
  lines: string[]
  dedupeKey: string
  kind: 'decline' | 'complaint' | 'high_value_sms'
  amount?: number
  wallet?: string | null
  smsId?: number
  smsCategory?: 'deposit' | 'withdrawal'
}

interface SmsAlertRow {
  id: number
  amount: number | null
  received_at: string | null
  sms_category: string | null
  receiver_number?: string | null
  wallet_number?: string | null
  confirmed_wallet_number?: string | null
  matched_ontarget_ref?: string | null
  matched_payout_ref?: string | null
  matched_tx_id?: number | null
}

const SESSION_KEY = 'ontarget:wrongful-decline-popup-seen'
const HIGH_VALUE_SMS_THRESHOLD_EVENT = 'ontarget:high-value-sms-threshold'
const DEFAULT_HIGH_VALUE_SMS_THRESHOLD = 5_000
const TELEGRAM_ALERT_ROLES = new Set(['owner', 'admin', 'super_admin', 'operator', 'operations_admin'])

const decode = (value: string) => {
  const node = document.createElement('textarea')
  node.innerHTML = value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:b|code|strong|em)>/gi, '')
  return node.value.trim()
}

const parseTelegramAlert = (row: AlertRow): PopupAlert | null => {
  if (row.alert_type !== 'wrongful_auto_decline' && row.alert_type !== 'complaint_filed') return null
  const clean = decode(row.message)
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const transactionRef = clean.match(/(?:TRX|Transaction|المعاملة)\s*:\s*(\d{6,12})/i)?.[1]
    ?? (row.alert_type === 'wrongful_auto_decline' ? clean.match(/\b(?:777\d{6}|\d{9,12})\b/)?.[0] : null)
  const kind = row.alert_type === 'complaint_filed' ? 'complaint' : 'decline'
  return { ...row, transactionRef: transactionRef ?? null, lines, kind, dedupeKey: `${kind}:${transactionRef ?? row.id}` }
}

export default function WrongfulDeclineRealtimePopup() {
  const { status, can, user } = useAuth()
  const { t } = useLocale()
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState<PopupAlert[]>([])
  const [highValueSmsThreshold, setHighValueSmsThreshold] = useState(DEFAULT_HIGH_VALUE_SMS_THRESHOLD)
  const seen = useRef(new Set<string>())
  const smsBaseline = useRef<number | null>(null)
  const dialog = useRef<HTMLElement | null>(null)
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const canSeeSms = can('sms_live')
  const canSeeTelegramAlerts = TELEGRAM_ALERT_ROLES.has(user?.role ?? '')

  useEffect(() => {
    if (status !== 'authed' || !canSeeSms) return
    let cancelled = false
    const load = () => void api<{ high_value_sms_popup_threshold?: number }>('/api/automation/popup-settings')
      .then((result) => {
        const value = Number(result.high_value_sms_popup_threshold)
        if (!cancelled && Number.isFinite(value) && value >= 0) setHighValueSmsThreshold(value)
      })
      .catch(() => { /* Keep the safe EGP 5,000 default while settings are unavailable. */ })
    const onThresholdChanged = (event: Event) => {
      const value = Number((event as CustomEvent<number>).detail)
      if (Number.isFinite(value) && value >= 0) setHighValueSmsThreshold(value)
    }
    load()
    const timer = window.setInterval(load, 60_000)
    window.addEventListener(HIGH_VALUE_SMS_THRESHOLD_EVENT, onThresholdChanged)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener(HIGH_VALUE_SMS_THRESHOLD_EVENT, onThresholdChanged)
    }
  }, [canSeeSms, status])

  useEffect(() => {
    try { seen.current = new Set(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '[]')) }
    catch { seen.current = new Set() }
  }, [])

  const enqueue = useCallback((alert: PopupAlert) => {
    if (seen.current.has(alert.dedupeKey)) return
    seen.current.add(alert.dedupeKey)
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen.current].slice(-500))) } catch { /* optional session dedupe */ }
    setAlerts((current) => [...current.slice(-4), alert])
    if (alert.kind !== 'decline') playNotificationTone('transaction')
  }, [])

  useEffect(() => {
    if (status !== 'authed' || !canSeeTelegramAlerts) return
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    const receive = (row: AlertRow) => {
      const parsed = parseTelegramAlert(row)
      if (parsed) enqueue(parsed)
    }
    void api<{ access_token: string }>('/api/auth/realtime-token').then(({ access_token }) => {
      if (cancelled) return
      supabase.realtime.setAuth(access_token)
      channel = supabase.channel(`operations-popups-${crypto.randomUUID()}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'telegram_alerts', filter: 'alert_type=eq.wrongful_auto_decline',
        }, (payload) => receive(payload.new as AlertRow))
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'telegram_alerts', filter: 'alert_type=eq.complaint_filed',
        }, (payload) => receive(payload.new as AlertRow))
        .subscribe()
      // Recover a complaint filed shortly before sign-in. Session dedupe keeps
      // the same ticket from appearing twice when Realtime also delivers it.
      void api<{ alerts?: AlertRow[] }>('/api/telegram/live?type=complaint_filed&limit=30').then(({ alerts: rows = [] }) => {
        if (cancelled) return
        const cutoff = Date.now() - 24 * 60 * 60_000
        const missed = rows.find((row) => new Date(row.created_at).getTime() >= cutoff)
        if (missed) receive(missed)
      }).catch(() => {})
    }).catch(() => { /* Authentication remains intact; only live popup is unavailable. */ })
    return () => { cancelled = true; if (channel) void supabase.removeChannel(channel) }
  }, [canSeeTelegramAlerts, enqueue, status])

  // The initial read establishes a baseline, so signing in never replays old
  // wallet messages. Later polls surface only newly arrived financial SMS
  // inbound and outbound SMS above the configured threshold. Changing the
  // threshold resets the baseline so old SMS records are never replayed as
  // new alerts.
  useEffect(() => {
    if (status !== 'authed' || !canSeeSms) return
    let cancelled = false
    const check = async () => {
      const { rows = [] } = await api<{ rows?: SmsAlertRow[] }>('/api/sms?limit=30')
      if (cancelled) return
      const newestId = Math.max(0, ...rows.map((row) => Number(row.id) || 0))
      if (smsBaseline.current == null) {
        smsBaseline.current = newestId
        return
      }
      const newRows = rows
        .filter((row) => Number(row.id) > Number(smsBaseline.current))
        .sort((left, right) => left.id - right.id)
      smsBaseline.current = Math.max(smsBaseline.current, newestId)
      for (const row of newRows) {
        const amount = Number(row.amount)
        if (!['deposit', 'withdrawal'].includes(row.sms_category ?? '') || !Number.isFinite(amount) || amount <= highValueSmsThreshold) continue
        const transactionRef = row.matched_ontarget_ref ?? row.matched_payout_ref ?? (row.matched_tx_id == null ? null : String(row.matched_tx_id))
        const wallet = row.confirmed_wallet_number ?? row.wallet_number ?? row.receiver_number ?? null
        enqueue({
          id: row.id,
          alert_type: 'high_value_sms',
          message: '',
          created_at: row.received_at ?? new Date().toISOString(),
          transactionRef,
          lines: [],
          dedupeKey: `high_value_sms:${row.id}`,
          kind: 'high_value_sms',
          amount,
          wallet,
          smsId: row.id,
          smsCategory: row.sms_category as 'deposit' | 'withdrawal',
        })
      }
    }
    void check().catch(() => {})
    const timer = window.setInterval(() => void check().catch(() => {}), 6_000)
    return () => { cancelled = true; window.clearInterval(timer); smsBaseline.current = null }
  }, [canSeeSms, enqueue, highValueSmsThreshold, status])

  const dismiss = useCallback((dedupeKey: string) => {
    setAlerts((current) => current.filter((item) => item.dedupeKey !== dedupeKey))
  }, [])
  const criticalAlert = alerts.find((alert) => alert.kind !== 'decline') ?? null
  const declineAlerts = alerts.filter((alert) => alert.kind === 'decline')
  const closeCritical = useCallback(() => {
    if (criticalAlert) dismiss(criticalAlert.dedupeKey)
  }, [criticalAlert, dismiss])

  useEffect(() => {
    if (!criticalAlert) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeCritical()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [closeCritical, criticalAlert])

  const openCritical = () => {
    if (!criticalAlert) return
    dismiss(criticalAlert.dedupeKey)
    if (criticalAlert.kind === 'complaint') {
      navigate(criticalAlert.transactionRef ? `/transactions/${encodeURIComponent(criticalAlert.transactionRef)}` : '/complaints')
    } else {
      navigate(`/sms?q=${encodeURIComponent(String(criticalAlert.smsId ?? criticalAlert.id))}`)
    }
  }

  if (!criticalAlert && !declineAlerts.length) return null
  return <>
    {declineAlerts.length > 0 && <aside className="wrongful-popup-stack" aria-live="assertive" aria-label={t('تنبيهات العمليات', 'Operations alerts')}>
      {declineAlerts.map((alert) => <article key={alert.dedupeKey} className="wrongful-popup" role="alert">
        <button className="wrongful-popup-close" onClick={() => dismiss(alert.dedupeKey)} aria-label={t('إغلاق', 'Close')}><X size={16}/></button>
        <button className="wrongful-popup-content" onClick={() => { dismiss(alert.dedupeKey); navigate(alert.transactionRef ? `/transactions/${encodeURIComponent(alert.transactionRef)}` : '/complaints') }}>
          <span className="wrongful-popup-icon"><AlertTriangle size={24}/></span>
          <span className="wrongful-popup-copy">
            <strong>{alert.lines[0]?.replace(/^[⚠️📣]\s*/, '') || t('رفض مشبوه يحتاج مراجعة بشرية', 'Suspicious decline requires human review')}</strong>
            {alert.lines.slice(1).map((line, index) => <span key={`${alert.dedupeKey}-${index}`} className={/(?:TRX|Transaction|المعاملة)\s*:/i.test(line) ? 'mono wrongful-popup-ref' : ''}>{line}</span>)}
            <small>{t('فتح المعاملة واتخاذ إجراء', 'Open transaction actions')}</small>
          </span>
        </button>
      </article>)}
    </aside>}
    {criticalAlert && <div className={`pending-work-overlay critical-alert-overlay ${criticalAlert.kind === 'complaint' ? 'complaint' : `high-value-sms ${criticalAlert.smsCategory === 'withdrawal' ? 'sms-out' : 'sms-in'}`}`} onMouseDown={closeCritical}>
      <article ref={dialog} className="pending-work-popup critical-alert-popup" role="alertdialog" aria-modal="true" aria-labelledby="critical-alert-title" onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeButton} type="button" className="pending-work-close" onClick={closeCritical} aria-label={t('إغلاق', 'Close')}><X size={17}/></button>
        <div className="pending-work-icon" aria-hidden="true">{criticalAlert.kind === 'complaint' ? <LifeBuoy size={27}/> : <CircleDollarSign size={27}/>}</div>
        <div className="pending-work-copy">
          <strong id="critical-alert-title">{criticalAlert.kind === 'complaint' ? t('تذكرة شكوى جديدة من Telegram', 'New complaint ticket from Telegram') : t(`رسالة SMS أكبر من ${money(highValueSmsThreshold, 'EGP')}`, `SMS message over ${money(highValueSmsThreshold, 'EGP')}`)}</strong>
          {criticalAlert.kind === 'complaint' ? <>
            {criticalAlert.lines.slice(1).map((line, index) => <span key={`${criticalAlert.dedupeKey}-${index}`} className={/(?:TRX|Transaction|المعاملة)\s*:/i.test(line) ? 'mono wrongful-popup-ref' : ''}>{line}</span>)}
          </> : <>
            <span className="mono">SMS #{criticalAlert.smsId}</span>
            {criticalAlert.amount != null && <span className="pending-work-amount">{money(criticalAlert.amount, 'EGP')}</span>}
            {criticalAlert.wallet && <span className="mono">{t('المحفظة', 'Wallet')}: {criticalAlert.wallet}</span>}
            {criticalAlert.transactionRef && <span className="mono wrongful-popup-ref">TRX: {criticalAlert.transactionRef}</span>}
          </>}
          <button type="button" className="btn-primary btn-sm pending-work-open" onClick={openCritical}>{criticalAlert.kind === 'complaint' ? t('فتح الشكوى', 'Open complaint') : t('فتح رسالة SMS', 'Open SMS')}</button>
        </div>
      </article>
    </div>}
  </>
}
