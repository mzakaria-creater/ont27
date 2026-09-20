import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'
import { getSoundSettings, installNotificationAudioUnlock, isNotificationAudioReady, playNotificationTone, saveSoundSettings, type AlertTone, type SoundSettings } from '../lib/notificationSounds'

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
  latestSms?: { id: number; received_at: string | null; sms_category: string | null } | null
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
  const isMobile = useIsMobile()
  const [data, setData] = useState<NotifData | null>(null)
  const [sounds, setSounds] = useState<SoundSettings>(() => getSoundSettings())
  const [audioReady, setAudioReady] = useState(() => isNotificationAudioReady())
  const updateSounds = (next: SoundSettings) => { setSounds(next); saveSoundSettings(next) }

  useEffect(() => {
    const load = () => void api<NotifData>('/api/notifications').then(setData).catch(() => {})
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => { installNotificationAudioUnlock(); const ready = () => setAudioReady(true); window.addEventListener('ontarget:audio-ready', ready); return () => window.removeEventListener('ontarget:audio-ready', ready) }, [])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🔔 {t('الإشعارات', 'Notifications')}</h2>
        <p className="page-sub">{t('كل ما يحتاج انتباهك الآن · تحديث تلقائي كل 30 ثانية', 'Everything that needs your attention now · auto-refresh every 30s')}</p>
      </section>

      <section className="card notification-sound-card">
        <div><h3>{t('أصوات التنبيه', 'Notification sounds')}</h3><p className="cell-sub">{t('نغمتان منفصلتان للمعاملات وSMS. اضغط اختبار مرة واحدة للسماح بالصوت في المتصفح.', 'Separate tones for transactions and SMS. Press Test once to allow browser audio.')}</p></div>
        <label className="sound-toggle"><input type="checkbox" checked={sounds.enabled} onChange={(e) => updateSounds({ ...sounds, enabled: e.target.checked })}/><span>{t('تشغيل الأصوات', 'Enable sounds')}</span></label>
        <span className={`pay-status-badge ${audioReady ? 'st-paid' : 'st-pending'}`}>{audioReady ? t('الصوت جاهز', 'Audio ready') : t('اضغط في الصفحة لتفعيل الصوت', 'Click anywhere to unlock audio')}</span>
        <SoundPicker label={t('معاملة جديدة', 'New transaction')} value={sounds.transaction} onChange={(transaction) => updateSounds({ ...sounds, transaction })} onTest={() => playNotificationTone('transaction', true)} t={t}/>
        <SoundPicker label={t('SMS جديدة', 'New SMS')} value={sounds.sms} onChange={(sms) => updateSounds({ ...sounds, sms })} onTest={() => playNotificationTone('sms', true)} t={t}/>
      </section>

      <EmailApprovalSubscriptions t={t} />

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
            {data.latestPending.length > 0 && (isMobile ? (
              <div className="risk-card-list">
                {data.latestPending.map((r) => (
                  <div key={r.tx_id} className="risk-row-card">
                    <div className="risk-row-card-head"><span className="mono">{r.ontarget_ref ?? r.tx_id}</span><span className="mono">{money(r.amount, r.currency)}</span></div>
                    <div className="cell-sub">{r.sender_name ?? '—'} · {r.merchant ?? '—'}</div>
                  </div>
                ))}
              </div>
            ) : (
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
            ))}
          </section>
        </>
      )}
    </PanelShell>
  )
}

function SoundPicker({ label, value, onChange, onTest, t }: { label: string; value: AlertTone; onChange: (tone: AlertTone) => void; onTest: () => void; t: (ar: string, en: string) => string }) {
  return <div className="sound-picker"><label>{label}<select className="login-input" value={value} onChange={(e) => onChange(e.target.value as AlertTone)}><option value="glass">Glass</option><option value="chime">Chime</option><option value="pulse">Pulse</option><option value="bell">Bell</option><option value="sonar">Sonar</option><option value="pop">Pop</option><option value="double">Double</option><option value="urgent">Urgent</option></select></label><button className="btn-ghost btn-sm" type="button" onClick={onTest}>{t('معاينة', 'Preview')}</button></div>
}


type EmailScope = 'all' | 'merchant' | 'country' | 'payment_method'
interface EmailRule {
  id: string
  email: string
  label: string | null
  scope_type: EmailScope
  scope_value: string | null
  active: boolean
}
interface EmailRulesResponse {
  rows: EmailRule[]
  options: Record<Exclude<EmailScope, 'all'>, string[]>
}

function EmailApprovalSubscriptions({ t }: { t: (ar: string, en: string) => string }) {
  const isMobile = useIsMobile()
  const [data, setData] = useState<EmailRulesResponse | null>(null)
  const [email, setEmail] = useState('')
  const [label, setLabel] = useState('')
  const [scopeType, setScopeType] = useState<EmailScope>('all')
  const [scopeValue, setScopeValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const load = () => api<EmailRulesResponse>('/api/email-notifications').then(setData).catch(() => setData(null))
  useEffect(() => { void load() }, [])

  const options = scopeType === 'all' ? [] : data?.options[scopeType] ?? []
  const add = async () => {
    if (!email.trim() || (scopeType !== 'all' && !scopeValue)) return
    setBusy(true); setMessage('')
    try {
      await api('/api/email-notifications', { method: 'POST', body: JSON.stringify({ email, label, scope_type: scopeType, scope_value: scopeType === 'all' ? null : scopeValue }) })
      setEmail(''); setLabel(''); setScopeType('all'); setScopeValue('')
      await load(); setMessage(t('تمت إضافة التعيين', 'Assignment added'))
    } catch { setMessage(t('تعذر حفظ التعيين أو أنه موجود بالفعل', 'Could not save assignment or it already exists')) }
    finally { setBusy(false) }
  }
  const toggle = async (row: EmailRule) => {
    await api(`/api/email-notifications/${row.id}`, { method: 'PATCH', body: JSON.stringify({ active: !row.active }) })
    await load()
  }
  const remove = async (row: EmailRule) => {
    if (!window.confirm(t('حذف تعيين البريد؟', 'Delete this email assignment?'))) return
    await api(`/api/email-notifications/${row.id}`, { method: 'DELETE' })
    await load()
  }
  const scopeLabel = (row: EmailRule) => row.scope_type === 'all'
    ? t('كل الموافقات', 'All approvals')
    : `${row.scope_type === 'merchant' ? t('تاجر', 'Merchant') : row.scope_type === 'country' ? t('دولة', 'Country') : t('طريقة دفع', 'Payment method')}: ${row.scope_value}`

  return <section className="card recent-card">
    <div className="recent-head">
      <div><h3>✉️ {t('إشعارات اعتماد المعاملات بالبريد', 'Approval email notifications')}</h3><p className="cell-sub">{t('إشعارات داخلية فقط. لن يتم إرسال البريد إلى العميل.', 'Internal recipients only. Customer emails are never used.')}</p></div>
    </div>
    <div className="filters-grid">
      <label>{t('اسم التعيين', 'Label')}<input className="login-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('مثال: فريق مصر', 'Example: Egypt team')} /></label>
      <label>{t('البريد المستلم', 'Recipient email')}<input className="login-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operations@company.com" /></label>
      <label>{t('نوع التعيين', 'Assignment type')}<select className="login-input" value={scopeType} onChange={(e) => { setScopeType(e.target.value as EmailScope); setScopeValue('') }}>
        <option value="all">{t('كل الموافقات', 'All approvals')}</option><option value="merchant">{t('حسب التاجر', 'By merchant')}</option><option value="country">{t('حسب الدولة', 'By country')}</option><option value="payment_method">{t('حسب طريقة الدفع', 'By payment method')}</option>
      </select></label>
      {scopeType !== 'all' && <label>{t('القيمة المحددة', 'Assigned value')}<select className="login-input" value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}><option value="">{t('اختر…', 'Select…')}</option>{options.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
    </div>
    <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}><button type="button" className="btn-primary" disabled={busy || !email.trim() || (scopeType !== 'all' && !scopeValue)} onClick={() => void add()}>{busy ? t('جارٍ الحفظ…', 'Saving…') : t('إضافة بريد وتعيين', 'Add email assignment')}</button>{message && <span className="cell-sub">{message}</span>}</div>
    {isMobile ? (
      <div className="risk-card-list" style={{ marginTop: 18 }}>
        {(data?.rows ?? []).map((row) => (
          <div key={row.id} className="risk-row-card">
            <div className="risk-row-card-head"><strong>{row.label ?? '—'}</strong><button type="button" className={`pay-status-badge ${row.active ? 'st-paid' : 'st-declined'}`} onClick={() => void toggle(row)}>{row.active ? t('نشط', 'Active') : t('متوقف', 'Paused')}</button></div>
            <div className="cell-sub mono">{row.email}</div>
            <div className="cell-sub">{scopeLabel(row)}</div>
            <div className="risk-row-card-foot"><button type="button" className="btn-ghost btn-sm" onClick={() => void remove(row)}>{t('حذف', 'Delete')}</button></div>
          </div>
        ))}
        {(data?.rows ?? []).length === 0 && <p className="maven-empty">{t('لا توجد تعيينات بريد بعد', 'No email assignments yet')}</p>}
      </div>
    ) : (
    <div className="table-wrap" style={{ marginTop: 18 }}><table className="data-table"><thead><tr><th>{t('الاسم', 'Label')}</th><th>{t('البريد', 'Email')}</th><th>{t('التعيين', 'Assignment')}</th><th>{t('الحالة', 'Status')}</th><th>{t('إجراء', 'Action')}</th></tr></thead><tbody>
      {(data?.rows ?? []).map((row) => <tr key={row.id}><td>{row.label ?? '—'}</td><td className="mono">{row.email}</td><td>{scopeLabel(row)}</td><td><button type="button" className={`pay-status-badge ${row.active ? 'st-paid' : 'st-declined'}`} onClick={() => void toggle(row)}>{row.active ? t('نشط', 'Active') : t('متوقف', 'Paused')}</button></td><td><button type="button" className="btn-ghost btn-sm" onClick={() => void remove(row)}>{t('حذف', 'Delete')}</button></td></tr>)}
      {(data?.rows ?? []).length === 0 && <tr><td colSpan={5}>{t('لا توجد تعيينات بريد بعد', 'No email assignments yet')}</td></tr>}
    </tbody></table></div>
    )}
  </section>
}
