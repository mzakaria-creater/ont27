import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, CheckCircle2, CircleDollarSign, Clock3, Pause, Play, Radio, RefreshCw, Server, Smartphone, XCircle, Zap } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { supabase } from '../lib/supabase'

type Tx = { tx_id: number; ontarget_ref: string | null; status: string; amount: number | null; currency: string | null; merchant: string | null; master_merchant: string | null; gateway: string | null; first_seen_at: string | null; last_status_change: string | null }
type Sms = { id: number; received_at: string | null; sms_category: string | null; amount: number | null; assigned_tx_id: number | string | null }
type MonitorData = { generatedAt: string; lastSync: string | null; api: { ok: boolean; latencyMs: number }; supabase: { ok: boolean; latencyMs: number }; queues: { pendingDeposits: number | null; pendingPayouts: number | null; editRequests: number | null }; sources: Record<string, { ok: boolean; error: string | null }>; sms: Sms[]; transactions: Tx[]; telegram: Array<{ id: number; alert_type: string; ok: boolean; error: string | null; created_at: string | null }>; devices: Array<{ device: string; online: boolean | null; last_seen_at: string | null }> }

const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'
const statusClass = (status: string) => status === 'PAID' || status === 'APPROVED' ? 'success' : status === 'DECLINED' || status === 'FAILED' ? 'error' : 'processing'

export default function LiveMonitorControl() {
  const { t } = useLocale()
  const [data, setData] = useState<MonitorData | null>(null)
  const [monitoring, setMonitoring] = useState(true)
  const [connection, setConnection] = useState<'connecting' | 'live' | 'fallback'>('connecting')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await api<MonitorData>('/api/monitoring')
      setData((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
      setError(null)
    } catch {
      setError(t('تعذّر الوصول إلى بيانات المراقبة الحية.', 'Live monitoring data could not be reached.'))
    } finally { setLoading(false) }
  }, [t])

  useEffect(() => {
    if (!monitoring) return
    void load()
    const interval = setInterval(() => void load(), 5_000)
    const channel = supabase.channel('ontarget-control-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maven_transactions' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbound_sms' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_alerts' }, () => void load())
      .subscribe((status) => setConnection(status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'fallback' : 'connecting'))
    return () => { clearInterval(interval); void supabase.removeChannel(channel) }
  }, [load, monitoring])

  const stats = useMemo(() => {
    const rows = data?.transactions ?? []
    const approved = rows.filter((row) => ['PAID', 'APPROVED'].includes(row.status)).length
    const rejected = rows.filter((row) => ['DECLINED', 'FAILED'].includes(row.status)).length
    const processing = rows.filter((row) => row.status === 'PENDING').length
    const decided = approved + rejected
    return { newCount: rows.length, processing, approved, rejected, total: rows.filter((row) => ['PAID', 'APPROVED'].includes(row.status)).reduce((sum, row) => sum + Number(row.amount ?? 0), 0), success: decided ? approved / decided * 100 : 0 }
  }, [data])

  const pending = useMemo(() => (data?.transactions ?? []).filter((row) => row.status === 'PENDING').slice(0, 4), [data])
  const logs = useMemo(() => data ? [
    ...data.transactions.map((row) => ({ key: `tx-${row.tx_id}`, at: row.last_status_change ?? row.first_seen_at, kind: statusClass(row.status), title: `${row.status} · ${row.ontarget_ref ?? row.tx_id}`, detail: `${money(row.amount, row.currency)} · ${row.merchant ?? row.gateway ?? 'OnTarget'}` })),
    ...data.sms.map((row) => ({ key: `sms-${row.id}`, at: row.received_at, kind: row.assigned_tx_id ? 'success' : 'warning', title: `SMS #${row.id}`, detail: `${money(row.amount, 'EGP')} · ${row.assigned_tx_id ? `TX ${row.assigned_tx_id}` : t('غير مرتبطة', 'Unlinked')}` })),
    ...data.telegram.map((row) => ({ key: `tg-${row.id}`, at: row.created_at, kind: row.ok ? 'success' : 'error', title: `Telegram · ${row.alert_type}`, detail: row.ok ? 'Delivered' : row.error ?? 'Failed' })),
  ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 50) : [], [data, t])

  const statCards = [
    { label: t('معاملات جديدة', 'New transactions'), value: stats.newCount, icon: Zap, tone: 'blue' },
    { label: t('قيد المعالجة', 'Processing'), value: stats.processing, icon: Clock3, tone: 'amber' },
    { label: t('تم التأكيد', 'Approved'), value: stats.approved, icon: CheckCircle2, tone: 'green' },
    { label: t('تم الرفض', 'Rejected'), value: stats.rejected, icon: XCircle, tone: 'red' },
    { label: t('حجم المدفوع', 'Paid volume'), value: money(stats.total, 'EGP'), icon: CircleDollarSign, tone: 'yellow' },
    { label: t('معدل النجاح', 'Success rate'), value: `${stats.success.toFixed(1)}%`, icon: Activity, tone: 'violet' },
  ]

  return <PanelShell>
    <div className="live-control-shell">
      <section className="live-control-head">
        <div className="live-control-title">
          <span className={`live-control-beacon ${monitoring ? 'active' : ''}`}><Radio size={24}/></span>
          <div><span className="page-eyebrow">ONTARGET OPERATIONS</span><h2>{t('مراقبة العمليات المباشرة', 'Live Operations Monitor')}</h2><p>{t('المعاملات، SMS، الطوابير، الأجهزة والتكاملات من مصدر النظام الحقيقي.', 'Transactions, SMS, queues, devices, and integrations from the live system source.')}</p></div>
        </div>
        <div className="live-control-actions">
          <div className="live-connection"><span className={`live-state-dot ${monitoring && connection === 'live' ? 'ok' : monitoring ? 'warn' : 'off'}`}/><div><small>{t('حالة النظام', 'System status')}</small><strong>{!monitoring ? 'PAUSED' : connection === 'live' ? 'LIVE' : connection === 'fallback' ? 'POLLING' : 'CONNECTING'}</strong></div></div>
          <div className="live-last-check"><small>{t('آخر فحص', 'Last check')}</small><strong className="mono">{data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : '—'}</strong></div>
          <button className={monitoring ? 'btn-ghost live-pause' : 'btn-primary'} onClick={() => setMonitoring((value) => !value)}>{monitoring ? <Pause size={16}/> : <Play size={16}/>} {monitoring ? t('إيقاف العرض', 'Pause view') : t('تشغيل المراقبة', 'Resume monitoring')}</button>
          <button className="btn-ghost icon-only" aria-label={t('تحديث الآن', 'Refresh now')} disabled={loading} onClick={() => void load()}><RefreshCw size={17} className={loading ? 'spin' : ''}/></button>
        </div>
      </section>

      {error && <div className="card warn">{error}</div>}
      <section className="live-stat-grid">{statCards.map(({ label, value, icon: Icon, tone }) => <article className={`live-stat-card ${tone}`} key={label}><span><Icon size={18}/>{label}</span><strong>{value}</strong><small>{t('آخر 24 ساعة', 'Last 24 hours')}</small></article>)}</section>

      <div className="live-control-grid">
        <main className="live-control-main">
          <section className="live-monitor-card">
            <header><div><span className="live-section-icon"><Zap size={18}/></span><div><h3>{t('المعالجة الحالية', 'Current processing')}</h3><small>{data?.queues.pendingDeposits ?? '—'} {t('إيداع معلق في الطابور', 'pending deposits in queue')}</small></div></div><Link to="/approvals" className="pay-status-link">{t('فتح طابور الموافقات', 'Open approval queue')} →</Link></header>
            <div className="live-processing-list">
              {pending.map((row) => <Link to={`/transactions/${encodeURIComponent(row.ontarget_ref ?? String(row.tx_id))}`} className="live-processing-row" key={row.tx_id}><span className="live-processing-pulse"><Activity size={17}/></span><div className="live-processing-copy"><strong className="mono">{row.ontarget_ref ?? row.tx_id}</strong><span>{row.merchant ?? row.master_merchant ?? row.gateway ?? 'OnTarget'}</span></div><strong className="mono live-processing-amount">{money(row.amount, row.currency)}</strong><span className="pay-status-badge st-pending">PENDING</span></Link>)}
              {data && pending.length === 0 && <div className="live-empty"><CheckCircle2 size={34}/><strong>{t('لا توجد معالجة معلقة', 'No pending processing')}</strong><span>{t('جميع المعاملات الحية لديها قرار.', 'All live transactions have a decision.')}</span></div>}
              {!data && <div className="live-empty"><Activity size={34}/><strong>{t('جارٍ الاتصال بالمصادر…', 'Connecting to live sources…')}</strong></div>}
            </div>
          </section>

          <section className="live-monitor-card">
            <header><div><span className="live-section-icon"><Server size={18}/></span><div><h3>{t('سجل المعاملات', 'Transaction history')}</h3><small>{t('آخر النشاطات الفعلية بدون بيانات تجريبية', 'Latest real activity — no simulated data')}</small></div></div><Link to="/transactions" className="pay-status-link">{t('كل المعاملات', 'All transactions')} →</Link></header>
            <div className="live-history-list">{(data?.transactions ?? []).slice(0, 12).map((row) => <Link to={`/transactions/${encodeURIComponent(row.ontarget_ref ?? String(row.tx_id))}`} className="live-history-row" key={row.tx_id}><span className={`live-history-status ${statusClass(row.status)}`}>{row.status === 'PAID' ? <CheckCircle2 size={18}/> : row.status === 'DECLINED' ? <XCircle size={18}/> : <Clock3 size={18}/>}</span><div><strong className="mono">{row.ontarget_ref ?? row.tx_id}</strong><small>{row.merchant ?? row.gateway ?? '—'} · {when(row.first_seen_at)}</small></div><strong className="mono">{money(row.amount, row.currency)}</strong><span className={`pay-status-badge st-${row.status === 'PAID' ? 'paid' : row.status === 'DECLINED' ? 'declined' : 'pending'}`}>{row.status}</span></Link>)}</div>
          </section>
        </main>

        <aside className="live-log-card">
          <header><div><span className="live-section-icon"><Radio size={18}/></span><div><h3>{t('سجل النظام المباشر', 'Live system log')}</h3><small>{logs.length} {t('حدثاً', 'events')}</small></div></div></header>
          <div className="live-source-strip"><span><Server size={14}/>{data?.api.ok ? 'API online' : 'API unavailable'}</span><span><Smartphone size={14}/>{data ? `${data.devices.filter((device) => device.online).length}/${data.devices.length}` : '—'} devices</span></div>
          <div className="live-log-list">{logs.map((entry) => <article className={`live-log-entry ${entry.kind}`} key={entry.key}><time>{entry.at ? new Date(entry.at).toLocaleTimeString() : '—'}</time><div><strong>{entry.title}</strong><span>{entry.detail}</span></div></article>)}{data && logs.length === 0 && <div className="live-empty"><Activity size={30}/><span>{t('لا توجد أحداث حديثة.', 'No recent events.')}</span></div>}</div>
        </aside>
      </div>
    </div>
  </PanelShell>
}
