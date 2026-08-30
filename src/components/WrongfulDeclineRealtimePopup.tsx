import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { supabase } from '../lib/supabase'
import { useLocale } from '../lib/locale'

interface AlertRow { id: number; alert_type: string; message: string; created_at: string }
interface PopupAlert extends AlertRow { transactionRef: string; lines: string[] }

const SESSION_KEY = 'ontarget:wrongful-decline-popup-seen'
const decode = (value: string) => {
  const node = document.createElement('textarea')
  node.innerHTML = value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:b|code|strong|em)>/gi, '')
  return node.value.trim()
}
const parse = (row: AlertRow): PopupAlert | null => {
  const clean = decode(row.message)
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const transactionRef = lines.find((line) => /^TRX\s*:/i.test(line))?.replace(/^TRX\s*:\s*/i, '').trim()
    ?? clean.match(/\b(?:777\d{6}|\d{9,12})\b/)?.[0]
  return transactionRef ? { ...row, transactionRef, lines } : null
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
    void api<{ access_token: string }>('/api/auth/realtime-token').then(({ access_token }) => {
      if (cancelled) return
      supabase.realtime.setAuth(access_token)
      channel = supabase.channel(`wrongful-decline-popups-${crypto.randomUUID()}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'telegram_alerts',
          filter: 'alert_type=eq.wrongful_auto_decline',
        }, (payload) => {
          const parsed = parse(payload.new as AlertRow)
          if (!parsed || seen.current.has(parsed.transactionRef)) return
          seen.current.add(parsed.transactionRef)
          sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen.current]))
          setAlerts((current) => [...current.slice(-2), parsed])
        }).subscribe()
    }).catch(() => { /* Authentication remains intact; only live popup is unavailable. */ })
    return () => { cancelled = true; if (channel) void supabase.removeChannel(channel) }
  }, [status])

  const dismiss = (id: number) => setAlerts((current) => current.filter((item) => item.id !== id))
  if (!alerts.length) return null
  return <aside className="wrongful-popup-stack" aria-live="assertive" aria-label={t('تنبيهات الرفض المشبوه', 'Suspicious decline alerts')}>
    {alerts.map((alert) => <article key={alert.id} className="wrongful-popup" role="alert">
      <button className="wrongful-popup-close" onClick={() => dismiss(alert.id)} aria-label={t('إغلاق', 'Close')}><X size={16}/></button>
      <button className="wrongful-popup-content" onClick={() => { dismiss(alert.id); navigate(`/transactions/${encodeURIComponent(alert.transactionRef)}`) }}>
        <span className="wrongful-popup-icon"><AlertTriangle size={24}/></span>
        <span className="wrongful-popup-copy">
          <strong>{alert.lines[0]?.replace(/^⚠️\s*/, '') || t('رفض مشبوه يحتاج مراجعة بشرية', 'Suspicious decline requires human review')}</strong>
          {alert.lines.slice(1).map((line, index) => <span key={`${alert.id}-${index}`} className={/^TRX\s*:/i.test(line) ? 'mono wrongful-popup-ref' : ''}>{line}</span>)}
          <small>{t('اضغط لفتح تفاصيل المعاملة', 'Click to open transaction details')}</small>
        </span>
      </button>
    </article>)}
  </aside>
}
