import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, LifeBuoy, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { supabase } from '../lib/supabase'
import { useLocale } from '../lib/locale'

interface AlertRow { id: number; alert_type: string; message: string; created_at: string }
interface PopupAlert extends AlertRow {
  transactionRef: string | null
  lines: string[]
  dedupeKey: string
  kind: 'decline' | 'complaint'
}

const SESSION_KEY = 'ontarget:wrongful-decline-popup-seen'
const decode = (value: string) => {
  const node = document.createElement('textarea')
  node.innerHTML = value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:b|code|strong|em)>/gi, '')
  return node.value.trim()
}
const parse = (row: AlertRow): PopupAlert | null => {
  if (row.alert_type !== 'wrongful_auto_decline' && row.alert_type !== 'complaint_filed') return null
  const clean = decode(row.message)
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const transactionRef = clean.match(/(?:TRX|Transaction|المعاملة)\s*:\s*(\d{6,12})/i)?.[1]
    ?? (row.alert_type === 'wrongful_auto_decline' ? clean.match(/\b(?:777\d{6}|\d{9,12})\b/)?.[0] : null)
  const kind = row.alert_type === 'complaint_filed' ? 'complaint' : 'decline'
  return { ...row, transactionRef: transactionRef ?? null, lines, kind, dedupeKey: `${kind}:${transactionRef ?? row.id}` }
}

export default function WrongfulDeclineRealtimePopup() {
  const { status } = useAuth()
  const { t } = useLocale()
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState<PopupAlert[]>([])
  const seen = useRef(new Set<string>())

  useEffect(() => {
    try { seen.current = new Set(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '[]')) }
    catch { seen.current = new Set() }
  }, [])

  useEffect(() => {
    if (status !== 'authed') return
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false
    const receive = (row: AlertRow) => {
      const parsed = parse(row)
      if (!parsed || seen.current.has(parsed.dedupeKey)) return
      seen.current.add(parsed.dedupeKey)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen.current]))
      setAlerts((current) => [...current.slice(-2), parsed])
    }
    void api<{ access_token: string }>('/api/auth/realtime-token').then(({ access_token }) => {
      if (cancelled) return
      supabase.realtime.setAuth(access_token)
      channel = supabase.channel(`wrongful-decline-popups-${crypto.randomUUID()}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'telegram_alerts', filter: 'alert_type=eq.wrongful_auto_decline',
        }, (payload) => receive(payload.new as AlertRow))
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'telegram_alerts', filter: 'alert_type=eq.complaint_filed',
        }, (payload) => receive(payload.new as AlertRow))
        .subscribe()
      // Realtime only delivers rows created after subscription. Recover the
      // newest recent complaint so an operator who signs in seconds later does
      // not miss the case entirely. Session dedupe still prevents repetition.
      void api<{ alerts?: AlertRow[] }>('/api/telegram/live').then(({ alerts = [] }) => {
        if (cancelled) return
        const cutoff = Date.now() - 24 * 60 * 60_000
        const missed = alerts.find((row) => row.alert_type === 'complaint_filed' && new Date(row.created_at).getTime() >= cutoff)
        if (missed) receive(missed)
      }).catch(() => {})
    }).catch(() => { /* Authentication remains intact; only live popup is unavailable. */ })
    return () => { cancelled = true; if (channel) void supabase.removeChannel(channel) }
  }, [status])

  const dismiss = (id: number) => setAlerts((current) => current.filter((item) => item.id !== id))
  if (!alerts.length) return null
  return <aside className="wrongful-popup-stack" aria-live="assertive" aria-label={t('تنبيهات العمليات والشكاوى', 'Operations and complaint alerts')}>
    {alerts.map((alert) => <article key={alert.id} className={`wrongful-popup${alert.kind === 'complaint' ? ' complaint-popup' : ''}`} role="alert">
      <button className="wrongful-popup-close" onClick={() => dismiss(alert.id)} aria-label={t('إغلاق', 'Close')}><X size={16}/></button>
      <button className="wrongful-popup-content" onClick={() => { dismiss(alert.id); navigate(alert.transactionRef ? `/transactions/${encodeURIComponent(alert.transactionRef)}` : '/complaints') }}>
        <span className="wrongful-popup-icon">{alert.kind === 'complaint' ? <LifeBuoy size={24}/> : <AlertTriangle size={24}/>}</span>
        <span className="wrongful-popup-copy">
          <strong>{alert.lines[0]?.replace(/^[⚠️📣]\s*/, '') || (alert.kind === 'complaint' ? t('شكوى جديدة من الدعم', 'New complaint from Support') : t('رفض مشبوه يحتاج مراجعة بشرية', 'Suspicious decline requires human review'))}</strong>
          {alert.lines.slice(1).map((line, index) => <span key={`${alert.id}-${index}`} className={/(?:TRX|Transaction|المعاملة)\s*:/i.test(line) ? 'mono wrongful-popup-ref' : ''}>{line}</span>)}
          <small>{alert.transactionRef ? t('فتح المعاملة واتخاذ إجراء', 'Open transaction actions') : t('فتح مركز الشكاوى', 'Open complaint center')}</small>
        </span>
      </button>
    </article>)}
  </aside>
}
