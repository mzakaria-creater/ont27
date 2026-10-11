import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ExternalLink, MessageSquareWarning, X } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { playNotificationTone } from '../lib/notificationSounds'
import { supabase } from '../lib/supabase'

// A transaction (still PENDING, or already auto-declined) whose transfer SMS
// the automation could not safely pair on its own: the SMS arrived late, or it
// carries no sender identity. public.propose_late_sms_matches() finds each one
// and writes a pending proposal; this popup puts it in front of an operator
// with the evidence and a Yes / No answer. Yes links the SMS and approves on
// the provider (with allow_reversal); No is remembered so the same pair is
// never asked again. X only hides it for this browser session.

interface Proposal {
  id: number
  tx_id: number
  sms_id: number
  ontarget_ref: string | null
  amount: number | string | null
  sender_number: string | null
  wallet: string | null
  merchant: string | null
  tx_created_at: string | null
  sms_received_at: string | null
  delay_seconds: number | null
  sms_sender_name: string | null
  match_basis: 'identity_phone' | 'crm_name' | string
  sms_blocked: boolean
  status: string
}

const SNOOZE_KEY = 'ontarget:late-sms-match-snoozed'
const POLL_MS = 20_000

const formatTime = (value: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const formatDelay = (seconds: number | null, t: (ar: string, en: string) => string) => {
  if (seconds == null) return '—'
  const abs = Math.abs(seconds)
  const text = abs >= 3600 ? `${Math.floor(abs / 3600)}h ${Math.round((abs % 3600) / 60)}m` : abs >= 60 ? `${Math.round(abs / 60)}m` : `${abs}s`
  return seconds < 0
    ? t(`قبل المعاملة بـ ${text}`, `${text} BEFORE the transaction`)
    : t(`بعد المعاملة بـ ${text}`, `${text} after the transaction`)
}

const basisLabel = (basis: string, t: (ar: string, en: string) => string) => {
  if (basis === 'identity_phone') return t('رقم المرسل + المبلغ', 'Sender phone + exact amount')
  if (basis === 'crm_name') return t('اسم العميل (CRM) + المبلغ', 'CRM-learned name + exact amount')
  return t('مبلغ فريد + وقت فقط (من غير هوية للمرسل)', 'Unique amount + time only (no sender identity)')
}

export default function LateSmsMatchPopup() {
  const { status, can } = useAuth()
  const { t } = useLocale()
  const [queue, setQueue] = useState<Proposal[]>([])
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const snoozed = useRef(new Set<number>())
  const announced = useRef(new Set<number>())
  const dialog = useRef<HTMLElement | null>(null)
  const canSee = can('deposits')

  useEffect(() => {
    try { snoozed.current = new Set(JSON.parse(sessionStorage.getItem(SNOOZE_KEY) ?? '[]')) } catch { snoozed.current = new Set() }
  }, [])

  const merge = useCallback((rows: Proposal[]) => {
    setQueue((current) => {
      const byId = new Map(current.map((row) => [row.id, row]))
      for (const row of rows) if (row.status === 'pending') byId.set(row.id, row)
      return [...byId.values()].sort((left, right) => left.id - right.id)
    })
    for (const row of rows) {
      if (row.status !== 'pending' || announced.current.has(row.id) || snoozed.current.has(row.id)) continue
      announced.current.add(row.id)
      playNotificationTone('transaction')
    }
  }, [])

  // Realtime for instant delivery, plus a poll as the safety net (and to pick
  // up proposals created while nobody was signed in).
  useEffect(() => {
    if (status !== 'authed' || !canSee) return
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null
    const load = () => void api<{ rows?: Proposal[] }>('/api/late-matches?status=pending&limit=20')
      .then(({ rows = [] }) => { if (!cancelled) merge(rows) })
      .catch(() => { /* popup is best effort; the proposal stays pending */ })
    load()
    const timer = window.setInterval(load, POLL_MS)
    void api<{ access_token: string }>('/api/auth/realtime-token').then(({ access_token }) => {
      if (cancelled) return
      supabase.realtime.setAuth(access_token)
      channel = supabase.channel(`late-sms-match-${crypto.randomUUID()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'late_sms_match_proposals' }, (payload) => merge([payload.new as Proposal]))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'late_sms_match_proposals' }, (payload) => {
          const row = payload.new as Proposal
          if (row.status !== 'pending') setQueue((current) => current.filter((item) => item.id !== row.id))
        })
        .subscribe()
    }).catch(() => { /* polling still works */ })
    return () => {
      cancelled = true
      window.clearInterval(timer)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [canSee, merge, status])

  const current = useMemo(() => queue.find((row) => !snoozed.current.has(row.id)) ?? null, [queue])
  useEffect(() => { setError(null) }, [current?.id])

  const snooze = useCallback(() => {
    if (!current || busy) return
    snoozed.current.add(current.id)
    try { sessionStorage.setItem(SNOOZE_KEY, JSON.stringify([...snoozed.current].slice(-200))) } catch { /* optional */ }
    setQueue((rows) => [...rows])
  }, [busy, current])

  useEffect(() => {
    if (!current) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); snooze() } }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, snooze])

  const decide = async (decision: 'approve' | 'reject') => {
    if (!current || busy) return
    setBusy(decision)
    setError(null)
    try {
      await api(`/api/late-matches/${current.id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) })
      setQueue((rows) => rows.filter((row) => row.id !== current.id))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 409 = someone else already answered or the pair changed; either way it is no longer actionable here.
      if (/already_decided|transaction_not_open|sms_already_linked|already_linked/.test(message)) setQueue((rows) => rows.filter((row) => row.id !== current.id))
      else setError(message)
    } finally {
      setBusy(null)
    }
  }

  const openTab = (path: string) => { window.open(path, '_blank', 'noopener,noreferrer') }

  if (!current) return null
  const before = (current.delay_seconds ?? 0) < 0
  const amount = Number(current.amount ?? 0)
  const txPath = `/transactions/${encodeURIComponent(current.ontarget_ref ?? String(current.tx_id))}`
  const smsPath = `/sms?q=${current.sms_id}`
  const waiting = queue.filter((row) => !snoozed.current.has(row.id)).length - 1

  return <div className="pending-work-overlay critical-alert-overlay high-value-sms sms-in" onMouseDown={snooze}>
    <article ref={dialog} className="pending-work-popup critical-alert-popup late-match-popup" role="alertdialog" aria-modal="true" aria-labelledby="late-match-title" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="pending-work-close" onClick={snooze} aria-label={t('إخفاء مؤقتًا', 'Hide for now')} disabled={busy != null}><X size={17}/></button>
      <div className="pending-work-icon" aria-hidden="true"><MessageSquareWarning size={27}/></div>
      <div className="pending-work-copy">
        <strong id="late-match-title">{t('رسالة SMS تطابق معاملة وتحتاج قرارك', 'An SMS matches a transaction and needs your decision')}</strong>
        <span className="pending-work-amount">{money(amount, 'EGP')}</span>
        <dl className="late-match-details">
          <dt>TRX</dt><dd className="mono wrongful-popup-ref">{current.ontarget_ref ?? current.tx_id}</dd>
          <dt>{t('العميل', 'Customer')}</dt><dd className="mono">{current.sender_number ?? '—'}</dd>
          <dt>{t('المحفظة', 'Wallet')}</dt><dd className="mono">{current.wallet ?? '—'}</dd>
          <dt>{t('التاجر', 'Merchant')}</dt><dd>{current.merchant ?? '—'}</dd>
          <dt>{t('وقت المعاملة', 'Transaction time')}</dt><dd>{formatTime(current.tx_created_at)}</dd>
          <dt>SMS</dt><dd><span className="mono">#{current.sms_id}</span> · {current.sms_sender_name ?? '—'}</dd>
          <dt>{t('وقت الرسالة', 'SMS time')}</dt><dd>{formatTime(current.sms_received_at)}</dd>
          <dt>{t('الفرق', 'Gap')}</dt><dd className={before ? 'late-match-warn' : undefined}>{formatDelay(current.delay_seconds, t)}</dd>
          <dt>{t('أساس المطابقة', 'Matched by')}</dt><dd>{basisLabel(current.match_basis, t)}</dd>
        </dl>
        {current.match_basis === 'unique_amount_time' && <span className="late-match-warn">{t('مفيش هوية للمرسل: الدليل الوحيد إن مفيش حاجة تانية بنفس المبلغ خلال 5 دقايق. راجع الاسم قبل الموافقة.', 'No sender identity: the only evidence is that nothing else with this exact amount appeared within 5 minutes. Check the name before approving.')}</span>}
        {before && <span className="late-match-warn">{t('تنبيه: الرسالة وصلت قبل المعاملة، تأكد إنها بتخصها.', 'Heads-up: the SMS arrived before the transaction, check it really belongs to it.')}</span>}
        {current.sms_blocked && <small>{t('الرسالة مقفولة بقاعدة الـ3 ساعات، والموافقة هتفك القفل وتسجّله باسمك.', 'This SMS carries the 3-hour assignment lock; approving unlocks it under your name.')}</small>}
        {error && <span className="late-match-error" role="alert">{error}</span>}
        <div className="late-match-actions">
          <button type="button" className="btn-primary btn-sm" onClick={() => void decide('approve')} disabled={busy != null}>
            <Check size={15}/> {busy === 'approve' ? t('جاري التنفيذ…', 'Approving…') : t('نعم، وافق', 'Yes, approve')}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => void decide('reject')} disabled={busy != null}>
            <X size={15}/> {busy === 'reject' ? t('جاري الحفظ…', 'Saving…') : t('لا، تجاهل', 'No, dismiss')}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => openTab(txPath)} disabled={busy != null}><ExternalLink size={14}/> {t('فتح المعاملة', 'Open transaction')}</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => openTab(smsPath)} disabled={busy != null}><ExternalLink size={14}/> {t('فتح الرسالة', 'Open SMS')}</button>
        </div>
        {waiting > 0 && <small>{t(`${waiting} اقتراح تاني في الانتظار`, `${waiting} more proposal(s) waiting`)}</small>}
      </div>
    </article>
  </div>
}
