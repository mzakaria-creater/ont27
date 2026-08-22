import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import type { DepositStats } from '../lib/deposits'
import { useLocale } from '../lib/locale'

const CONTROL_ROLES = new Set(['owner', 'admin', 'super_admin'])
const REFRESH_MS = 20_000

interface QueueGuess { score: number | null; sms_id: number | null; reasons: string[] | null }
interface QueueItem { tx_id: number; amount: number | null; sms_id: number | null; best_guess: QueueGuess | null }
interface ControlStatus {
  settings: { automation_enabled: boolean | null; max_auto_amount: number | null; turbo_mode?: boolean | null } | null
  stats: Record<string, unknown> | null
  queue: QueueItem[]
}
interface MonitorData {
  generatedAt: string
  lastSync: string | null
  sources: Record<string, { ok: boolean }>
  sms: { id: number; sms_category: string | null; assigned_tx_id: number | string | null }[]
  devices: { device: string; online: boolean | null; battery: number | null; last_seen_at: string | null }[]
  telegram: { id: number; ok: boolean; created_at: string | null }[]
}

const age = (iso: string | null, t: (ar: string, en: string) => string) => {
  if (!iso) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return t(`منذ ${seconds} ث`, `${seconds}s ago`)
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t(`منذ ${minutes} د`, `${minutes}m ago`)
  return t(`منذ ${Math.round(minutes / 60)} س`, `${Math.round(minutes / 60)}h ago`)
}

export default function Dashboard() {
  const { user } = useAuth()
  const { t } = useLocale()
  const canControl = Boolean(user && CONTROL_ROLES.has(user.role))
  const [stats, setStats] = useState<DepositStats | null>(null)
  const [monitor, setMonitor] = useState<MonitorData | null>(null)
  const [control, setControl] = useState<ControlStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [limit, setLimit] = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const [statsResult, monitorResult, controlResult] = await Promise.allSettled([
      api<DepositStats>('/api/deposits/stats'),
      api<MonitorData>('/api/monitoring'),
      canControl ? api<ControlStatus>('/api/control/status') : Promise.resolve(null),
    ])
    if (statsResult.status === 'fulfilled') setStats(statsResult.value)
    if (monitorResult.status === 'fulfilled') setMonitor(monitorResult.value)
    if (controlResult.status === 'fulfilled' && controlResult.value) {
      setControl(controlResult.value)
      if (controlResult.value.settings?.max_auto_amount != null) setLimit(String(controlResult.value.settings.max_auto_amount))
    }
    setError(statsResult.status === 'rejected' && monitorResult.status === 'rejected')
    setLoading(false)
  }, [canControl])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(true), REFRESH_MS)
    return () => clearInterval(interval)
  }, [load])

  const action = async (key: string, path: string, body: Record<string, unknown>, message: string) => {
    setBusy(key); setNotice(null)
    try {
      await api(`/api/control/${path}`, { method: 'POST', body: JSON.stringify(body) })
      setNotice(message)
      await load(true)
    } catch { setNotice(t('تعذّر تنفيذ الإجراء. حاول مرة أخرى.', 'Action failed. Please try again.')) }
    finally { setBusy(null) }
  }

  const queue = control?.queue ?? []
  const engineOn = control?.settings?.automation_enabled === true
  const unassignedSms = monitor?.sms.filter((row) => !row.assigned_tx_id && ['deposit', 'withdrawal'].includes(row.sms_category ?? '')).length ?? 0
  const onlineDevices = monitor?.devices.filter((row) => row.online).length ?? 0
  const healthySources = monitor ? Object.values(monitor.sources).filter((source) => source.ok).length : 0
  const totalSources = monitor ? Object.keys(monitor.sources).length : 0
  const firstName = user?.display_name?.split(' ')[0] ?? user?.username ?? ''
  const paidRate = stats && stats.day.paid.count + stats.day.declined > 0
    ? Math.round((stats.day.paid.count / (stats.day.paid.count + stats.day.declined)) * 100)
    : 0

  const healthTone = useMemo(() => {
    if (!monitor) return 'unknown'
    if (healthySources === totalSources && onlineDevices > 0) return 'healthy'
    return 'attention'
  }, [monitor, healthySources, totalSources, onlineDevices])

  return <PanelShell>
    <section className="command-hero">
      <div>
        <span className="command-kicker">{t('مركز العمليات', 'OPERATIONS COMMAND')}</span>
        <h2>{t(`صباح الخير، ${firstName}`, `Good day, ${firstName}`)}</h2>
        <p>{t('صورة واحدة لما يتحرك الآن، وما يحتاج قرارك تالياً.', 'One view of what is moving now and what needs your decision next.')}</p>
      </div>
      <div className="command-hero-status">
        <span className={`command-health ${healthTone}`}><i />{healthTone === 'healthy' ? t('الأنظمة مستقرة', 'Systems healthy') : healthTone === 'attention' ? t('تحتاج انتباه', 'Needs attention') : t('جارٍ الاتصال', 'Connecting')}</span>
        <button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}>{loading ? t('جارٍ التحديث…', 'Refreshing…') : t('تحديث الآن', 'Refresh now')}</button>
        <small>{t('آخر مزامنة', 'Last sync')} {age(monitor?.lastSync ?? null, t)}</small>
      </div>
    </section>

    {error && <div className="card warn">{t('تعذّر الوصول إلى مصادر البيانات الحية.', 'Live data sources are currently unavailable.')}</div>}

    <section className="command-metrics" aria-label={t('ملخص العمليات', 'Operations summary')}>
      <Link to="/approvals" className="command-metric attention"><span>{t('بانتظار قرار — 24 ساعة', 'Awaiting decision — 24h')}</span><strong>{stats?.pending ?? '…'}</strong><small>{stats ? t(`${stats.pendingStale ?? 0} قديمة خارج العداد`, `${stats.pendingStale ?? 0} older outside this count`) : t('إيداعات معلّقة', 'pending deposits')}</small><b>→</b></Link>
      <Link to="/sms?match=unmatched" className={`command-metric${unassignedSms ? ' attention' : ''}`}><span>{t('SMS غير مرتبطة', 'Unmatched SMS')}</span><strong>{monitor ? unassignedSms : '…'}</strong><small>{t('تحتاج مطابقة معاملة', 'need transaction matching')}</small><b>→</b></Link>
      <div className="command-metric"><span>{t('مدفوع اليوم', 'Paid today')}</span><strong>{stats ? money(stats.day.paid.volume, 'EGP') : '…'}</strong><small>{stats ? `${stats.day.paid.count} ${t('معاملة', 'transactions')} · ${paidRate}%` : ''}</small></div>
      <Link to="/wallets" className={`command-metric${monitor && onlineDevices < monitor.devices.length ? ' attention' : ''}`}><span>{t('الأجهزة المتصلة', 'Devices online')}</span><strong>{monitor ? `${onlineDevices}/${monitor.devices.length}` : '…'}</strong><small>{t('نبض مباشر', 'live heartbeat')}</small><b>→</b></Link>
    </section>

    <div className="command-grid">
      <section className="card command-queue">
        <header className="command-section-head">
          <div><span className="command-kicker">{t('الأولوية الآن', 'NEXT PRIORITY')}</span><h3>{t('طابور غرفة التحكم', 'Control-room queue')}</h3></div>
          <span className={`command-count${queue.length ? ' active' : ''}`}>{queue.length}</span>
        </header>
        {!canControl ? <div className="command-empty"><span>🔒</span><strong>{t('عرض الإدارة فقط', 'Management view')}</strong><p>{t('تظهر قرارات المطابقة والأتمتة لأدوار الإدارة.', 'Matching and automation decisions are available to management roles.')}</p></div>
          : !control ? <div className="command-loading">{t('جارٍ تحميل الطابور…', 'Loading queue…')}</div>
          : queue.length === 0 ? <div className="command-empty"><span>✓</span><strong>{t('لا توجد قرارات معلّقة', 'No pending decisions')}</strong><p>{t('كل المعاملات الحالية تمت معالجتها.', 'All current transactions have been handled.')}</p></div>
          : <div className="command-queue-list">{queue.slice(0, 8).map((item, index) => {
              const smsId = item.sms_id ?? item.best_guess?.sms_id
              const score = item.best_guess?.score
              const confidence = score != null && score >= 85 ? 'high' : score != null && score >= 65 ? 'medium' : 'low'
              return <article className="command-queue-row" key={item.tx_id}>
                <span className="queue-index mono">{String(index + 1).padStart(2, '0')}</span>
                <div className="queue-identity"><Link to={`/transactions/${item.tx_id}`} className="mono">TX {item.tx_id}</Link><strong className="mono">{money(item.amount, 'EGP')}</strong></div>
                <div className="queue-evidence">{smsId ? <><span className="mono">SMS #{smsId}</span><em className={`confidence ${confidence}`}>{score ?? '—'}%</em></> : <span className="muted">{t('بدون دليل SMS', 'No SMS evidence')}</span>}<small>{item.best_guess?.reasons?.slice(0, 2).join(' · ') ?? t('يتطلب مراجعة يدوية', 'Manual review required')}</small></div>
                <button className="btn-primary btn-sm" disabled={!smsId || busy === `queue-${item.tx_id}`} onClick={() => smsId && void action(`queue-${item.tx_id}`, 'queue/approve', { tx_id: item.tx_id, sms_id: smsId }, t(`تم اعتماد ${item.tx_id}`, `Transaction ${item.tx_id} approved`))}>{busy === `queue-${item.tx_id}` ? '…' : t('ربط واعتماد', 'Link & approve')}</button>
              </article>
            })}</div>}
      </section>

      <aside className="command-side">
        {canControl && <section className="card command-engine">
          <header className="command-section-head"><div><span className="command-kicker">{t('الأتمتة', 'AUTOMATION')}</span><h3>{t('محرك الموافقات', 'Approval engine')}</h3></div><span className={`engine-pill ${engineOn ? 'on' : 'off'}`}><i />{engineOn ? t('يعمل', 'Running') : t('متوقف', 'Paused')}</span></header>
          <div className="engine-main-number"><span>{t('الحد التلقائي الحالي', 'Current auto limit')}</span><strong className="mono">{money(control?.settings?.max_auto_amount ?? null, 'EGP')}</strong></div>
          <div className="engine-buttons"><button className="btn-primary" disabled={!control || engineOn || busy === 'engine'} onClick={() => void action('engine', 'automation', { on: true }, t('تم تشغيل المحرك', 'Engine started'))}>▶ {t('تشغيل', 'Start')}</button><button className="btn-ghost danger" disabled={!control || !engineOn || busy === 'engine'} onClick={() => void action('engine', 'automation', { on: false }, t('تم إيقاف المحرك', 'Engine paused'))}>Ⅱ {t('إيقاف', 'Pause')}</button></div>
          <label className="engine-limit"><span>{t('تعديل الحد', 'Change limit')}</span><div><input className="login-input mono" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} /><button className="btn-ghost btn-sm" disabled={!limit || busy === 'limit'} onClick={() => void action('limit', 'limit', { limit: Number(limit) }, t('تم حفظ الحد', 'Limit saved'))}>{t('حفظ', 'Save')}</button></div></label>
          {notice && <p className="command-notice">{notice}</p>}
        </section>}

        <section className="card command-health-card">
          <header className="command-section-head"><div><span className="command-kicker">{t('البنية الحية', 'LIVE INFRASTRUCTURE')}</span><h3>{t('حالة التدفقات', 'Flow health')}</h3></div><Link to="/monitor" className="pay-status-link">{t('تفاصيل', 'Details')} →</Link></header>
          <div className="source-list">{monitor ? Object.entries(monitor.sources).map(([name, source]) => <div key={name}><span><i className={source.ok ? 'ok' : 'bad'} />{name}</span><b>{source.ok ? t('متصل', 'Online') : t('خطأ', 'Issue')}</b></div>) : <span className="muted">{t('جارٍ فحص المصادر…', 'Checking sources…')}</span>}</div>
        </section>
      </aside>
    </div>

    <section className="card command-activity">
      <header className="command-section-head"><div><span className="command-kicker">{t('آخر حركة', 'RECENT ACTIVITY')}</span><h3>{t('المعاملات الواردة', 'Incoming transactions')}</h3></div><Link to="/transactions" className="pay-status-link">{t('كل المعاملات', 'All transactions')} →</Link></header>
      {!stats ? <p className="command-loading">{t('جارٍ تحميل المعاملات…', 'Loading transactions…')}</p> : <div className="table-wrap"><table className="data-table command-table"><thead><tr><th>{t('المرجع', 'Reference')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('المرسل', 'Sender')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('الحالة', 'Status')}</th><th>{t('وصلت', 'Received')}</th></tr></thead><tbody>{stats.recent.slice(0, 8).map((row) => { const status = statusMeta(row.status); return <tr key={row.tx_id}><td><Link to={`/transactions/${row.ontarget_ref ?? row.tx_id}`} className="mono command-ref">{row.ontarget_ref ?? row.tx_id}</Link></td><td className="mono command-money">{money(row.amount, row.currency)}</td><td>{row.sender_name ?? row.sender_number ?? '—'}</td><td>{row.merchant ?? '—'}</td><td><span className={`pay-status-badge ${status.cls}`}>{status.label}</span></td><td className="mono muted">{depositTime(row)}</td></tr>})}</tbody></table></div>}
    </section>
  </PanelShell>
}
