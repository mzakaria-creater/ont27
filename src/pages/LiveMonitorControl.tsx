import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, CheckCircle2, CircleDollarSign, Clock3, FileSearch, Pause, Play, Radio, RefreshCw, Scale, Server, ShieldCheck, Smartphone, XCircle, Zap } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { supabase } from '../lib/supabase'

type Tx = { tx_id: number; ontarget_ref: string | null; status: string; amount: number | null; currency: string | null; merchant: string | null; master_merchant: string | null; gateway: string | null; first_seen_at: string | null; last_status_change: string | null }
type Sms = { id: number; received_at: string | null; sms_category: string | null; amount: number | null; assigned_tx_id: number | string | null }
type MonitorData = { generatedAt: string; lastSync: string | null; api: { ok: boolean; latencyMs: number }; supabase: { ok: boolean; latencyMs: number }; queues: { pendingDeposits: number | null; pendingPayouts: number | null; editRequests: number | null }; sources: Record<string, { ok: boolean; error: string | null }>; sms: Sms[]; transactions: Tx[]; telegram: Array<{ id: number; alert_type: string; ok: boolean; error: string | null; created_at: string | null }>; devices: Array<{ device: string; online: boolean | null; last_seen_at: string | null }> }
type MarketPrices = { xauUsd: number | null; usdtEgp: number | null; usdtBuyEgp?: number | null; usdtSellEgp?: number | null; updatedAt: string; latencyMs: number }

const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'
const statusClass = (status: string) => status === 'PAID' || status === 'APPROVED' ? 'success' : status === 'DECLINED' || status === 'FAILED' ? 'error' : 'processing'

export default function LiveMonitorControl() {
  const { t } = useLocale()
  const [data, setData] = useState<MonitorData | null>(null)
  const [monitoring, setMonitoring] = useState(true)
  const [connection, setConnection] = useState<'connecting' | 'live' | 'fallback'>('connecting')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prices, setPrices] = useState<MarketPrices | null>(null)

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

  const loadPrices = useCallback(async () => {
    try { setPrices(await api<MarketPrices>('/api/monitoring/market-prices')) } catch { /* unavailable state is rendered as — */ }
  }, [])

  useEffect(() => {
    if (!monitoring) return
    void load()
    void loadPrices()
    const interval = setInterval(() => void load(), 5_000)
    const priceInterval = setInterval(() => void loadPrices(), 30_000)
    const channel = supabase.channel('ontarget-control-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maven_transactions' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbound_sms' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_alerts' }, () => void load())
      .subscribe((status) => setConnection(status === 'SUBSCRIBED' ? 'live' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'fallback' : 'connecting'))
    return () => { clearInterval(interval); clearInterval(priceInterval); void supabase.removeChannel(channel) }
  }, [load, loadPrices, monitoring])

  const stats = useMemo(() => {
    const today = new Date().toLocaleDateString()
    const rows = (data?.transactions ?? []).filter((row) => {
      const timestamp = row.last_status_change ?? row.first_seen_at
      return timestamp ? new Date(timestamp).toLocaleDateString() === today : false
    })
    const approved = rows.filter((row) => ['PAID', 'APPROVED'].includes(row.status)).length
    const rejected = rows.filter((row) => ['DECLINED', 'FAILED'].includes(row.status)).length
    const processing = rows.filter((row) => row.status === 'PENDING').length
    const decided = approved + rejected
    return { newCount: rows.length, processing, approved, rejected, total: rows.filter((row) => ['PAID', 'APPROVED'].includes(row.status)).reduce((sum, row) => sum + Number(row.amount ?? 0), 0), success: decided ? approved / decided * 100 : 0 }
  }, [data])

  const pending = useMemo(() => (data?.transactions ?? []).filter((row) => row.status === 'PENDING').slice(0, 4), [data])
  const activeTx = pending[0] ?? null
  const activeSms = useMemo(() => activeTx ? (data?.sms ?? []).find((row) => String(row.assigned_tx_id ?? '') === String(activeTx.tx_id)) ?? null : null, [activeTx, data])
  const logs = useMemo(() => data ? [
    ...data.transactions.map((row) => ({ key: `tx-${row.tx_id}`, at: row.last_status_change ?? row.first_seen_at, kind: statusClass(row.status), title: `${row.status} · ${row.ontarget_ref ?? row.tx_id}`, detail: `${money(row.amount, row.currency)} · ${row.merchant ?? row.gateway ?? 'OnTarget'}` })),
    ...data.sms.map((row) => ({ key: `sms-${row.id}`, at: row.received_at, kind: row.assigned_tx_id ? 'success' : 'warning', title: `SMS #${row.id}`, detail: `${money(row.amount, 'EGP')} · ${row.assigned_tx_id ? `TX ${row.assigned_tx_id}` : t('غير مرتبطة', 'Unlinked')}` })),
    ...data.telegram.map((row) => ({ key: `tg-${row.id}`, at: row.created_at, kind: row.ok ? 'success' : 'error', title: `Telegram · ${row.alert_type}`, detail: row.ok ? 'Delivered' : row.error ?? 'Failed' })),
  ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 50) : [], [data, t])

  const statCards = [
      { label: t('معاملات اليوم', 'Today transactions'), value: stats.newCount, icon: Zap, tone: 'blue' },
    { label: t('قيد المعالجة', 'Processing'), value: stats.processing, icon: Clock3, tone: 'amber' },
    { label: t('تم التأكيد', 'Approved'), value: stats.approved, icon: CheckCircle2, tone: 'green' },
    { label: t('تم الرفض', 'Rejected'), value: stats.rejected, icon: XCircle, tone: 'red' },
      { label: t('حجم المدفوع اليوم', 'Today paid volume'), value: money(stats.total, 'EGP'), icon: CircleDollarSign, tone: 'yellow' },
      { label: t('معدل نجاح اليوم', 'Today success rate'), value: `${stats.success.toFixed(1)}%`, icon: Activity, tone: 'violet' },
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
      <section className="live-stat-grid">{statCards.map(({ label, value, icon: Icon, tone }) => <article className={`live-stat-card ${tone}`} key={label}><span><Icon size={18}/>{label}</span><strong>{value}</strong><small>{t('من بداية اليوم', 'Since start of today')}</small></article>)}</section>
      <section className="live-market-grid" aria-label={t('أسعار السوق الحية', 'Live market prices')}>
        <article className="live-market-card gold"><div><span className="live-market-icon">XAU</span><div><strong>XAU / USD</strong><small>{t('الذهب الفوري · أونصة', 'Gold spot · per troy ounce')}</small></div></div><strong className="mono">{prices?.xauUsd != null ? `$${prices.xauUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}</strong><small>{prices?.updatedAt ? `${t('محدّث', 'Updated')} ${new Date(prices.updatedAt).toLocaleTimeString()}` : t('جاري التحميل…', 'Loading…')}</small></article>
        <article className="live-market-card usdt"><div><span className="live-market-icon">₮</span><div><strong>USDT / EGP</strong><small>{t('متوسط Binance P2P الحي', 'Live Binance P2P midpoint')}</small></div></div><strong className="mono">{prices?.usdtEgp != null ? `${prices.usdtEgp.toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP` : '—'}</strong><small>{prices?.usdtBuyEgp != null || prices?.usdtSellEgp != null ? `${t('شراء', 'Buy')} ${prices.usdtBuyEgp?.toFixed(2) ?? '—'} · ${t('بيع', 'Sell')} ${prices.usdtSellEgp?.toFixed(2) ?? '—'}` : t('لا توجد عروض حالياً', 'No live offers currently')} · {prices?.updatedAt ? `${t('محدّث', 'Updated')} ${new Date(prices.updatedAt).toLocaleTimeString()}` : t('جاري التحميل…', 'Loading…')}</small></article>
      </section>

      <div className="live-control-grid">
        <main className="live-control-main">
          <section className="live-monitor-card">
            <header><div><span className="live-section-icon"><Zap size={18}/></span><div><h3>{t('المعالجة الحالية', 'Current processing')}</h3><small>{data?.queues.pendingDeposits ?? '—'} {t('إيداع معلق في الطابور', 'pending deposits in queue')}</small></div></div><Link to="/approvals" className="pay-status-link">{t('فتح طابور الموافقات', 'Open approval queue')} →</Link></header>
            <div className="live-processing-list">
              {activeTx && <div className="live-active-process">
                <div className="live-active-summary">
                  <span className="live-active-bolt"><Zap size={23}/></span>
                  <div><span>{t('معاملة جديدة', 'New transaction')}</span><Link to={`/transactions/${encodeURIComponent(activeTx.ontarget_ref ?? String(activeTx.tx_id))}`} className="mono">{activeTx.ontarget_ref ?? activeTx.tx_id}</Link><small>{t('جاري فحصها بواسطة محرك OnTarget', 'Being checked by the OnTarget engine')}</small></div>
                  <div className="live-active-money"><strong>{money(activeTx.amount, activeTx.currency)}</strong><small>{activeTx.gateway ?? activeTx.merchant ?? 'P2P'}</small></div>
                </div>
                <div className="live-active-details" aria-label={t('تفاصيل المعاملة المفحوصة', 'Checked transaction details')}>
                  <div><small>{t('رقم المعاملة', 'Transaction ID')}</small><strong className="mono">{activeTx.tx_id}</strong></div>
                  <div><small>{t('المرجع', 'Merchant reference')}</small><strong className="mono">{activeTx.ontarget_ref ?? '—'}</strong></div>
                  <div><small>{t('الحالة الحالية', 'Current status')}</small><strong><span className="pay-status-badge st-pending">{activeTx.status}</span></strong></div>
                  <div><small>{t('التاجر', 'Merchant')}</small><strong>{activeTx.merchant ?? activeTx.master_merchant ?? '—'}</strong></div>
                  <div><small>{t('البوابة', 'Gateway')}</small><strong>{activeTx.gateway ?? '—'}</strong></div>
                  <div><small>{t('وقت الإنشاء', 'Created')}</small><strong className="mono">{when(activeTx.first_seen_at)}</strong></div>
                  <div><small>{t('آخر تغيير', 'Last status change')}</small><strong className="mono">{when(activeTx.last_status_change)}</strong></div>
                  <div><small>{t('فحص SMS', 'SMS check')}</small><strong className={activeSms ? 'detail-ok' : 'detail-wait'}>{activeSms ? `✓ #${activeSms.id}` : t('بانتظار المطابقة', 'Awaiting match')}</strong></div>
                </div>
                <div className="live-pipeline">
                  <div className="live-pipeline-step complete"><span><CheckCircle2 size={18}/></span><div><strong>{t('1. استخراج بيانات المعاملة', '1. Extract transaction data')}</strong><small>{t('تم الاستلام من المصدر الحي', 'Received from the live provider source')}</small></div></div>
                  <div className={`live-pipeline-step ${activeSms ? 'complete' : 'waiting'}`}><span>{activeSms ? <CheckCircle2 size={18}/> : <FileSearch size={18}/>}</span><div><strong>{t('2. فحص دليل الدفع و SMS', '2. Scan payment proof and SMS')}</strong><small>{activeSms ? `${t('SMS مرتبطة', 'Linked SMS')} #${activeSms.id} · ${money(activeSms.amount, 'EGP')}` : t('بانتظار دليل موثوق أو SMS مرتبطة', 'Waiting for trusted proof or a linked SMS')}</small></div></div>
                  <div className={`live-pipeline-step ${activeSms ? 'complete' : 'waiting'}`}><span>{activeSms ? <CheckCircle2 size={18}/> : <Scale size={18}/>}</span><div><strong>{t('3. مقارنة البيانات', '3. Compare evidence')}</strong><small>{activeSms ? t('تم ربط الدليل بنفس رقم المعاملة', 'Evidence is linked to this transaction') : t('لا توجد مطابقة مؤكدة بعد', 'No confirmed match yet')}</small></div></div>
                  <div className="live-pipeline-step processing"><span><ShieldCheck size={18}/></span><div><strong>{t('4. اتخاذ القرار', '4. Apply decision')}</strong><small>{t('بانتظار قرار الأتمتة الآمن أو موافقة بشرية', 'Waiting for a safe automation decision or human approval')}</small></div><Link to="/approvals" className="btn-primary btn-sm">{t('اتخاذ إجراء', 'Take action')}</Link></div>
                </div>
                {pending.length > 1 && <div className="live-pending-more">+{pending.length - 1} {t('معاملات أخرى ظاهرة في الطابور', 'more transactions visible in the queue')}</div>}
              </div>}
              {data && !activeTx && <div className="live-empty"><CheckCircle2 size={34}/><strong>{t('في انتظار معاملة جديدة…', 'Waiting for a new transaction…')}</strong><span>{t('يتم فحص القناة كل 5 ثوانٍ وعبر Realtime.', 'The channel is checked every 5 seconds and through Realtime.')}</span></div>}
              {!data && <div className="live-empty"><Activity size={34}/><strong>{t('جارٍ الاتصال بالمصادر…', 'Connecting to live sources…')}</strong></div>}
            </div>
          </section>

          <section className="live-monitor-card">
            <header><div><span className="live-section-icon"><Server size={18}/></span><div><h3>{t('سجل المعاملات', 'Transaction history')}</h3><small>{t('آخر النشاطات الفعلية بدون بيانات تجريبية', 'Latest real activity — no simulated data')}</small></div></div><Link to="/transactions" className="pay-status-link">{t('كل المعاملات', 'All transactions')} →</Link></header>
            <div className="live-history-list">{(data?.transactions ?? []).slice(0, 12).map((row) => { const approved = ['PAID', 'APPROVED'].includes(row.status); const rejected = ['DECLINED', 'FAILED'].includes(row.status); return <Link to={`/transactions/${encodeURIComponent(row.ontarget_ref ?? String(row.tx_id))}`} className="live-history-row" key={row.tx_id}><span className={`live-history-status ${statusClass(row.status)}`}>{approved ? <CheckCircle2 size={18}/> : rejected ? <XCircle size={18}/> : <Clock3 size={18}/>}</span><div><strong className="mono">{row.ontarget_ref ?? row.tx_id}</strong><small>{row.merchant ?? row.gateway ?? '—'} · {when(row.first_seen_at)}</small></div><strong className="mono">{money(row.amount, row.currency)}</strong><span className={`live-history-stamp ${approved ? 'approved' : rejected ? 'rejected' : 'pending'}`}>{approved ? 'APPROVED' : rejected ? 'REJECTED' : row.status}</span></Link> })}</div>
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
