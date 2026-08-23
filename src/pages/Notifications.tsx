import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { getSoundSettings, playNotificationTone, saveSoundSettings, type AlertTone, type SoundSettings } from '../lib/notificationSounds'

// Notifications center — the bell's data, expanded.

export interface NotifData {
  pendingDeposits: number
  pendingDepositsStale?: number
  pendingPayouts: number
  smsReview: number
  offlineDevices: string[]
  latestPending: { tx_id: number; ontarget_ref: string | null; amount: number | null; currency: string | null; sender_name: string | null; merchant: string | null; master_merchant?: string | null }[]
  latestPayouts?: { maven_id: number; ontarget_ref: string | null; amount: number | null; account_name: string | null; mobile_no: string | null; merchant: string | null }[]
  recentMatches?: { id: number; received_at: string | null; device_name: string | null; sender_name: string | null; amount: number | null; trx_id: string | null; matched_transaction_id: number | null }[]
  // Edit requests raised by the signed-in user that have since been decided —
  // the only place they learn the outcome, since the approval happens in
  // Telegram or in a steward's panel.
  myEditRequests?: {
    id: number; tx_id: number; ontarget_ref: string | null; status: string
    decided_by: string | null; decided_at: string | null
    decision_note: string | null; apply_error: string | null
    requested_status: string | null; requested_amount: number | null
  }[]
  total: number
}

export default function Notifications() {
  const { t } = useLocale()
  const [data, setData] = useState<NotifData | null>(null)
  const [sounds, setSounds] = useState<SoundSettings>(() => getSoundSettings())
  const updateSounds = (next: SoundSettings) => { setSounds(next); saveSoundSettings(next) }

  useEffect(() => {
    const load = () => void api<NotifData>('/api/notifications').then(setData).catch(() => {})
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🔔 {t('الإشعارات', 'Notifications')}</h2>
        <p className="page-sub">{t('كل ما يحتاج انتباهك الآن · تحديث تلقائي كل 30 ثانية', 'Everything that needs your attention now · auto-refresh every 30s')}</p>
      </section>

      <section className="card notification-sound-card">
        <div><h3>{t('أصوات التنبيه', 'Notification sounds')}</h3><p className="cell-sub">{t('نغمتان منفصلتان للمعاملات وSMS. اضغط اختبار مرة واحدة للسماح بالصوت في المتصفح.', 'Separate tones for transactions and SMS. Press Test once to allow browser audio.')}</p></div>
        <label className="sound-toggle"><input type="checkbox" checked={sounds.enabled} onChange={(e) => updateSounds({ ...sounds, enabled: e.target.checked })}/><span>{t('تشغيل الأصوات', 'Enable sounds')}</span></label>
        <SoundPicker label={t('معاملة جديدة', 'New transaction')} value={sounds.transaction} onChange={(transaction) => updateSounds({ ...sounds, transaction })} onTest={() => playNotificationTone('transaction', true)} t={t}/>
        <SoundPicker label={t('SMS جديدة', 'New SMS')} value={sounds.sms} onChange={(sms) => updateSounds({ ...sounds, sms })} onTest={() => playNotificationTone('sms', true)} t={t}/>
      </section>

      {!data && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {data && (
        <>
          <div className="kpi-grid">
            <Link to="/deposits?status=PENDING" className="kpi-card amber">
              <span className="kpi-icon">💰</span>
              <div className="kpi-value">{data.pendingDeposits}</div>
              <div className="kpi-label">{t('إيداعات معلّقة', 'Pending deposits')}</div>
            </Link>
            <Link to="/payouts?status=PENDING" className="kpi-card amber">
              <span className="kpi-icon">📤</span>
              <div className="kpi-value">{data.pendingPayouts}</div>
              <div className="kpi-label">{t('سحوبات معلّقة', 'Pending payouts')}</div>
            </Link>
            <Link to="/sms?match=review" className="kpi-card">
              <span className="kpi-icon">📨</span>
              <div className="kpi-value">{data.smsReview}</div>
              <div className="kpi-label">{t('رسائل تحتاج مراجعة (48 ساعة)', 'SMS needing review (48h)')}</div>
            </Link>
            <Link to="/wallets" className="kpi-card">
              <span className="kpi-icon">📵</span>
              <div className="kpi-value">{data.offlineDevices.length}</div>
              <div className="kpi-label">{t('أجهزة غير متصلة', 'Offline devices')}{data.offlineDevices.length > 0 && `: ${data.offlineDevices.join('، ')}`}</div>
            </Link>
          </div>

          <section className="card recent-card">
            <div className="recent-head">
              <h3>{t('أحدث الإيداعات المعلّقة', 'Latest pending deposits')}</h3>
              <Link to="/approvals" className="pay-status-link">{t('فتح طابور الموافقات ←', 'Open approval queue →')}</Link>
            </div>
            {data.latestPending.length === 0 && <p>{t('لا يوجد شيء معلّق 🎉', 'Nothing pending 🎉')}</p>}
            {data.latestPending.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>{t('رقم العملية', 'Ref')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('المُرسِل', 'Sender')}</th><th>{t('التاجر', 'Merchant')}</th></tr></thead>
                  <tbody>
                    {data.latestPending.map((r) => (
                      <tr key={r.tx_id}>
                        <td className="mono">{r.ontarget_ref ?? r.tx_id}</td>
                        <td className="mono">{money(r.amount, r.currency)}</td>
                        <td>{r.sender_name ?? '—'}</td>
                        <td>{r.merchant ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </PanelShell>
  )
}

function SoundPicker({ label, value, onChange, onTest, t }: { label: string; value: AlertTone; onChange: (tone: AlertTone) => void; onTest: () => void; t: (ar: string, en: string) => string }) {
  return <div className="sound-picker"><label>{label}<select className="login-input" value={value} onChange={(e) => onChange(e.target.value as AlertTone)}><option value="glass">Glass</option><option value="chime">Chime</option><option value="pulse">Pulse</option></select></label><button className="btn-ghost btn-sm" type="button" onClick={onTest}>{t('اختبار', 'Test')}</button></div>
}
