import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { providerLabel } from './PaymentCheckout'
import type { PaySession } from './PaymentCheckout'
import { useLocale } from '../lib/locale'

const POLL_MS = 5000

const statusInfo: Record<string, { ar: string; en: string; cls: string; icon: string }> = {
  pending: { ar: 'بانتظار التحويل', en: 'Awaiting transfer', cls: 'st-pending', icon: '⏳' },
  processing: { ar: 'جارٍ التحقق', en: 'Verifying', cls: 'st-pending', icon: '🔄' },
  approved: { ar: 'تم الدفع بنجاح', en: 'Payment successful', cls: 'st-paid', icon: '✅' },
  declined: { ar: 'مرفوض', en: 'Declined', cls: 'st-declined', icon: '❌' },
  expired: { ar: 'انتهت صلاحية الجلسة', en: 'Session expired', cls: 'st-dim', icon: '⌛' },
}

export default function PaymentStatus() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  const id = params.get('id')
  const [session, setSession] = useState<PaySession | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [lastCheck, setLastCheck] = useState<Date | null>(null)
  const [ago, setAgo] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!id) { setNotFound(true); return }
    let alive = true
    const load = async () => {
      try {
        const { session } = await api<{ session: PaySession }>(`/api/pay/session/${id}`)
        if (!alive) return
        setSession(session)
        setLastCheck(new Date())
        // Terminal states stop the poll
        if (['approved', 'declined', 'expired'].includes(session.status) && timer.current) {
          clearInterval(timer.current)
        }
      } catch {
        if (alive) setNotFound(true)
        if (timer.current) clearInterval(timer.current)
      }
    }
    void load()
    timer.current = setInterval(load, POLL_MS)
    return () => { alive = false; if (timer.current) clearInterval(timer.current) }
  }, [id])

  useEffect(() => {
    const iv = setInterval(() => {
      if (lastCheck) setAgo(Math.round((Date.now() - lastCheck.getTime()) / 1000))
    }, 1000)
    return () => clearInterval(iv)
  }, [lastCheck])

  if (notFound) {
    return <div className="pay-wrap"><div className="card pay-card"><h2>⚠️ {t('الجلسة غير موجودة', 'Session not found')}</h2></div></div>
  }
  if (!session) {
    return <div className="pay-wrap"><span className="conn"><span className="dot wait" /> {t('جارٍ التحميل…', 'Loading…')}</span></div>
  }

  const info = statusInfo[session.status] ?? statusInfo.pending
  const steps = [
    { label: t('إنشاء الطلب', 'Order created'), done: true, time: session.created_at },
    { label: t('بانتظار التحويل', 'Awaiting transfer'), done: session.status !== 'pending' || false, active: session.status === 'pending', time: null },
    session.status === 'declined'
      ? { label: t('مرفوض', 'Declined'), done: true, time: null }
      : session.status === 'expired'
        ? { label: t('انتهت الصلاحية', 'Expired'), done: true, time: session.expires_at }
        : { label: t('تأكيد الدفع', 'Payment confirmed'), done: session.status === 'approved', time: session.paid_at },
  ]

  return (
    <div className="pay-wrap">
      <div className="card pay-card">
        <img src="/logo.svg" alt="OnTarget" className="login-logo" />
        <div className={`pay-status-badge ${info.cls}`}>{info.icon} {t(info.ar, info.en)}</div>
        <div className="pay-amount">{session.amount} <span>{session.currency}</span></div>
        <ul className="timeline">
          {steps.map((s, i) => (
            <li key={i} className={s.done ? 'done' : 'active' in s && s.active ? 'active' : ''}>
              <span>{s.label}</span>
              {s.time && (
                <time className="mono">
                  {new Date(s.time).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                </time>
              )}
            </li>
          ))}
        </ul>
        <div className="pay-details">
          <div><span>{t('المرجع', 'Reference')}</span><span className="mono">{session.reference}</span></div>
          {session.wallet_number && <div><span>{t('المحفظة', 'Wallet')}</span><span className="mono">{session.wallet_number}</span></div>}
          {session.provider && <div><span>{t('القناة', 'Channel')}</span><span>{providerLabel(session.provider, session.channel_name)}</span></div>}
          {session.customer_phone && <div><span>{t('رقم العميل', 'Customer phone')}</span><span className="mono">{session.customer_phone}</span></div>}
        </div>
        {!['approved', 'declined', 'expired'].includes(session.status) && (
          <p className="pay-note">
            <span className="dot wait" /> {t('تحديث تلقائي كل 5 ثوانٍ · آخر فحص منذ', 'Auto-refresh every 5s · last check')} {ago} {t('ثانية', 's ago')}
          </p>
        )}
      </div>
    </div>
  )
}
