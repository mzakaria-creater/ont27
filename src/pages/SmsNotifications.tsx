import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

type Severity = 'freeze' | 'warning'
interface SmsAlert { id: number; received_at: string | null; device_name: string | null; provider: string | null; sender_name: string | null; receiver_number: string | null; wallet_number: string | null; amount: number | null; balance_after: number | null; sms_category: string | null; message: string | null; raw_sms: string | null; sms_first_line: string | null; severity: Severity; alert_reason: string }
interface ResponseData { alerts: SmsAlert[]; counts: { freeze: number; warning: number }; processed?: { sent: number } }

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : '—'
const textOf = (row: SmsAlert) => row.message || row.raw_sms || row.sms_first_line || '—'

export default function SmsNotifications() {
  const { t } = useLocale()
  const [data, setData] = useState<ResponseData | null>(null)
  const [severity, setSeverity] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { setData(await api<ResponseData>(`/api/sms-notifications?hours=168${severity ? `&severity=${severity}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`)); setError(null) }
    catch (e) { setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض تنبيهات SMS.', 'You do not have permission to view SMS alerts.') : t('تعذّر تحميل تنبيهات SMS.', 'Unable to load SMS alerts.')) }
  }, [q, severity, t])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer) }, [load])
  const rows = useMemo(() => data?.alerts ?? [], [data])

  return <PanelShell>
    <section className="page-head">
      <h2>🚨 {t('تنبيهات وتحذيرات SMS', 'SMS notifications & warnings')}</h2>
      <p className="page-sub">{t('تجميد المحافظ والتحذيرات المالية مع تحديث تلقائي وإشعار Telegram.', 'Wallet freeze and financial warnings with auto-refresh and Telegram delivery.')}</p>
    </section>
    <div className="kpi-grid sms-alert-kpis">
      <button className={`kpi-card sms-alert-kpi freeze ${severity === 'freeze' ? 'is-selected' : ''}`} onClick={() => setSeverity(severity === 'freeze' ? '' : 'freeze')}><span className="kpi-icon">🧊</span><div className="kpi-value">{data?.counts.freeze ?? '…'}</div><div className="kpi-label">{t('تنبيهات تجميد المحفظة', 'Wallet freeze alerts')}</div></button>
      <button className={`kpi-card sms-alert-kpi warning ${severity === 'warning' ? 'is-selected' : ''}`} onClick={() => setSeverity(severity === 'warning' ? '' : 'warning')}><span className="kpi-icon">⚠️</span><div className="kpi-value">{data?.counts.warning ?? '…'}</div><div className="kpi-label">{t('تحذيرات SMS', 'SMS warnings')}</div></button>
      <div className="kpi-card"><span className="kpi-icon">✈️</span><div className="kpi-value">{data?.processed?.sent ?? 0}</div><div className="kpi-label">{t('إشعارات Telegram في آخر فحص', 'Telegram deliveries in last scan')}</div></div>
    </div>
    <div className="filter-bar sms-alert-filter"><div className="chip-row"><button className={severity === '' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setSeverity('')}>{t('الكل', 'All')}</button><button className={severity === 'freeze' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setSeverity('freeze')}>🧊 {t('تجميد', 'Freeze')}</button><button className={severity === 'warning' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setSeverity('warning')}>⚠️ {t('تحذير', 'Warning')}</button></div><div className="search-row"><input className="login-input search-input" value={q} onChange={(event) => setQ(event.target.value)} placeholder={t('بحث بالرسالة أو المحفظة أو الجهاز…', 'Search message, wallet, or device…')} /><button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button></div></div>
    {error && <div className="card warn">{error}</div>}
    <section className="card recent-card">
      <div className="recent-head"><h3>{t('سجل تنبيهات SMS', 'SMS alert log')}</h3><span className="cell-sub">{rows.length} · {t('آخر 7 أيام', 'last 7 days')}</span></div>
      {rows.length === 0 ? <p className="sidebar-hint">{t('لا توجد رسائل مطابقة.', 'No matching alert messages.')}</p> : <div className="table-wrap"><table className="data-table sms-alert-table"><thead><tr><th>{t('الدرجة', 'Severity')}</th><th>SMS ID</th><th>{t('الوقت', 'Time')}</th><th>{t('المحفظة', 'Wallet')}</th><th>{t('الجهاز / المزود', 'Device / provider')}</th><th>{t('الرسالة', 'Message')}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className={row.severity === 'freeze' ? 'sms-freeze-row' : 'sms-warning-row'}><td><span className={`pay-status-badge ${row.severity === 'freeze' ? 'st-declined' : 'st-pending'}`}>{row.severity === 'freeze' ? `🧊 ${t('تجميد', 'Freeze')}` : `⚠️ ${t('تحذير', 'Warning')}`}</span></td><td className="mono">{row.id}</td><td className="mono">{formatTime(row.received_at)}</td><td className="mono">{row.wallet_number ?? row.receiver_number ?? '—'}</td><td>{row.device_name ?? '—'}<div className="cell-sub">{row.provider ?? '—'}</div></td><td className="sms-alert-message" title={textOf(row)}>{textOf(row)}</td></tr>)}</tbody></table></div>}
    </section>
  </PanelShell>
}
