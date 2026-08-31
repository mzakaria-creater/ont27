import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { supabase } from '../lib/supabase'

type Source = { ok: boolean; error: string | null }
type Sms = { id: number; received_at: string | null; sms_category: string | null; amount: number | null; trx_id: string | null; assigned_tx_id: number | string | null }
type Tx = { tx_id: number; ontarget_ref: string | null; status: string; amount: number | null; currency: string | null; merchant: string | null; master_merchant: string | null; gateway: string | null; first_seen_at: string | null; last_status_change: string | null }
type Tg = { id: number; alert_type: string; chat_id: string | null; ok: boolean; error: string | null; created_at: string | null }
type Integration = { id: number; action: string; entity: string; entity_id: string | null; actor_name: string | null; after: { status?: number | null; latency_ms?: number; destination_host?: string; error?: string } | null; created_at: string | null }
type Device = { device: string; sim_slot: number | null; online: boolean | null; battery: number | null; charging: boolean | null; net_type: string | null; last_seen_at: string | null }
type ProviderState = { count24h: number; pending: number; lastChange: string | null; latestTransaction: string | null; stale: boolean }
type MonitorData = { generatedAt: string; lastSync: string | null; api: { ok: boolean; latencyMs: number }; supabase: { ok: boolean; latencyMs: number; failedSources: string[] }; queues: { pendingDeposits: number | null; pendingPayouts: number | null; editRequests: number | null }; providers: { nagopay: ProviderState; payfuture: ProviderState }; sources: Record<string, Source>; sms: Sms[]; transactions: Tx[]; telegram: Tg[]; email: Integration[]; webhooks: Integration[]; devices: Device[] }

const POLL_MS = 15_000
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'

export default function Monitor() {
  const { t } = useLocale()
  const [data, setData] = useState<MonitorData | null>(null)
  const [error, setError] = useState(false)
  const [realtime, setRealtime] = useState<'connecting' | 'connected' | 'degraded'>('connecting')

  const load = useCallback(async () => {
    try { setData(await api<MonitorData>('/api/monitoring')); setError(false) }
    catch { setError(true) }
  }, [])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), POLL_MS)
    const channel = supabase.channel('panel-live-monitor')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbound_sms' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maven_transactions' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_alerts' }, () => void load())
      .subscribe((status) => setRealtime(status === 'SUBSCRIBED' ? 'connected' : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'degraded' : 'connecting'))
    return () => { clearInterval(interval); void supabase.removeChannel(channel) }
  }, [load])

  const events = useMemo(() => data ? [
    ...data.sms.map((r) => ({ key: `s${r.id}`, at: r.received_at, type: 'SMS', title: `${r.sms_category ?? 'message'} · ${money(r.amount, 'EGP')}`, detail: r.assigned_tx_id ? `TRX ${r.trx_id ?? '—'} → TX ${r.assigned_tx_id}` : `TRX ${r.trx_id ?? '—'} · unassigned`, ok: Boolean(r.assigned_tx_id) })),
    ...data.transactions.map((r) => ({ key: `t${r.tx_id}`, at: r.last_status_change ?? r.first_seen_at, type: t('معاملة', 'Transaction'), title: `${r.ontarget_ref ?? r.tx_id} · ${money(r.amount, r.currency)}`, detail: `${r.status} · ${r.merchant ?? '—'}`, ok: r.status === 'PAID' })),
    ...data.telegram.map((r) => ({ key: `g${r.id}`, at: r.created_at, type: 'Telegram', title: r.alert_type, detail: r.ok ? `OK · ${r.chat_id ?? '—'}` : r.error ?? 'Failed', ok: r.ok })),
    ...data.email.map((r) => ({ key: `e${r.id}`, at: r.created_at, type: 'Email', title: r.action, detail: r.entity_id ?? r.actor_name ?? '—', ok: true })),
    ...data.webhooks.map((r) => ({ key: `w${r.id}`, at: r.created_at, type: 'Webhook', title: r.action, detail: r.entity_id ?? '—', ok: true })),
  ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 50) : [], [data, t])

  const online = data?.devices.filter((d) => d.online).length ?? 0
  const unassigned = data?.sms.filter((s) => !s.assigned_tx_id && ['deposit', 'withdrawal'].includes(s.sms_category ?? '')).length ?? 0

  return <PanelShell>
    <section className="page-head">
      <div className="recent-head"><h2 style={{ margin: 0 }}>📡 {t('المراقبة المباشرة', 'Live Monitoring')}</h2><button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button></div>
      <p className="page-sub">{t('تدفق SMS والمعاملات والتكاملات وحالة الأجهزة.', 'SMS, transaction, integration, and device activity in one operational stream.')}</p>
    </section>
    {error && <div className="card warn">{t('تعذّر تحميل بيانات المراقبة.', 'Unable to load monitoring data.')}</div>}
    <div className="stat-grid">
      <div className="stat-card"><span className="stat-label">WebSocket / Realtime</span><span className="stat-value" style={{ fontSize: '1.1rem' }}>{realtime === 'connected' ? '● Connected' : realtime === 'degraded' ? '● Polling fallback' : '○ Connecting'}</span><span className="stat-sub">{t('تحديث احتياطي كل 15 ثانية', '15-second polling fallback')}</span></div>
      <div className="stat-card"><span className="stat-label">{t('آخر مزامنة', 'Last sync')}</span><span className="stat-value" style={{ fontSize: '1.1rem' }}>{when(data?.lastSync ?? null)}</span><span className="stat-sub">API {data ? '●' : '○'} · {data?.generatedAt ? when(data.generatedAt) : '—'}</span></div>
      <Link to="/sms?match=unmatched" className={`stat-card${unassigned ? ' stat-pending' : ''}`}><span className="stat-label">{t('SMS غير مسندة', 'Unassigned SMS')}</span><span className="stat-value">{data ? unassigned : '…'}</span><span className="stat-sub">{t('مطابقة TRX مع المعاملة', 'TRX-to-transaction matching')}</span></Link>
      <div className="stat-card"><span className="stat-label">{t('نبض الأجهزة', 'Device heartbeat')}</span><span className="stat-value">{data ? `${online}/${data.devices.length}` : '…'}</span><span className="stat-sub">{t('أجهزة متصلة', 'devices online')}</span></div>
      <div className="stat-card"><span className="stat-label">Live API</span><span className="stat-value" style={{ fontSize: '1.1rem' }}>{data?.api.ok ? '● Healthy' : '○ Unavailable'}</span><span className="stat-sub mono">{data ? `${data.api.latencyMs} ms` : '—'}</span></div>
      <div className={`stat-card${data && !data.supabase.ok ? ' stat-pending' : ''}`}><span className="stat-label">Supabase Health</span><span className="stat-value" style={{ fontSize: '1.1rem' }}>{data?.supabase.ok ? '● Healthy' : data ? '● Degraded' : '○ Checking'}</span><span className="stat-sub mono">{data ? `${data.supabase.latencyMs} ms${data.supabase.failedSources.length ? ` · ${data.supabase.failedSources.join(', ')}` : ''}` : '—'}</span></div>
    </div>

    <section className="card recent-card"><div className="recent-head"><h3>{t('مزامنة المزوّدين', 'Provider live sync')}</h3><span className="live-dot"><span className="ld" />{t('كل 15 ثانية', 'every 15 seconds')}</span></div><div className="stat-grid">
      {data && Object.entries(data.providers).map(([name, state]) => <div className={`stat-card${state.stale ? ' stat-pending' : ''}`} key={name}><span className="stat-label">{name === 'nagopay' ? 'NagoPay / NGPay' : 'PayFuture'} {state.stale ? '⚠' : '●'}</span><span className="stat-value">{state.count24h}</span><span className="stat-sub">{state.pending} {t('معلقة', 'pending')} · {t('آخر تغيير', 'last change')} {when(state.lastChange)} · {t('آخر معاملة', 'latest transaction')} {when(state.latestTransaction)}</span></div>)}
      {!data && <div className="stat-card"><span className="stat-label">NagoPay / PayFuture</span><span className="stat-value">…</span></div>}
    </div></section>

    <section className="card recent-card"><div className="recent-head"><h3>{t('مراقبة الطوابير', 'Queue monitor')}</h3><Link to="/approvals" className="pay-status-link">{t('فتح الموافقات ←', 'Open approvals →')}</Link></div><div className="stat-grid">
      <div className="stat-card"><span className="stat-label">{t('إيداعات معلقة', 'Pending deposits')}</span><span className="stat-value">{data?.queues.pendingDeposits ?? '—'}</span></div>
      <div className="stat-card"><span className="stat-label">{t('سحوبات معلقة', 'Pending payouts')}</span><span className="stat-value">{data?.queues.pendingPayouts ?? '—'}</span></div>
      <div className="stat-card"><span className="stat-label">{t('طلبات تعديل', 'Edit requests')}</span><span className="stat-value">{data?.queues.editRequests ?? '—'}</span></div>
    </div></section>

    <section className="card recent-card"><div className="recent-head"><h3>{t('حالة المصادر', 'Connection status')}</h3></div><div className="chip-row">
      {data && Object.entries(data.sources).map(([name, source]) => <span key={name} className={`pay-status-badge ${source.ok ? 'st-paid' : 'st-declined'}`} title={source.error ?? undefined}>{source.ok ? '●' : '○'} {name}</span>)}
      {!data && <span className="sidebar-hint">{t('جارٍ الاتصال…', 'Connecting…')}</span>}
    </div></section>

    <section className="card recent-card"><div className="recent-head"><h3>{t('الإشعارات الواردة', 'Incoming notifications')}</h3><span className="mono">{events.length}</span></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المصدر', 'Source')}</th><th>{t('الحدث', 'Event')}</th><th>{t('التفاصيل', 'Details')}</th><th>{t('الوقت', 'Time')}</th></tr></thead><tbody>
        {events.map((e) => <tr key={e.key}><td><span className={`pay-status-badge ${e.ok ? 'st-paid' : 'st-pending'}`}>{e.type}</span></td><td>{e.title}</td><td className="mono">{e.detail}</td><td className="mono">{when(e.at)}</td></tr>)}
        {data && events.length === 0 && <tr><td colSpan={4} className="sidebar-hint">{t('لا توجد أحداث في آخر 24 ساعة.', 'No events in the last 24 hours.')}</td></tr>}
      </tbody></table></div>
      {data && data.email.length === 0 && <p className="sidebar-hint">Gmail parser: {t('لا توجد أحداث مسجلة في سجل التدقيق.', 'No events recorded in the audit log.')}</p>}
    </section>

    <section className="card recent-card"><div className="recent-head"><h3>{t('مراقبة Callback / Webhook', 'Callback / Webhook monitor')}</h3><span className="mono">{data?.webhooks.length ?? 0}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('النتيجة', 'Result')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('الوجهة', 'Destination')}</th><th>{t('الاستجابة', 'Response')}</th><th>{t('الوقت', 'Time')}</th></tr></thead><tbody>
      {(data?.webhooks ?? []).map((row) => { const ok = row.action === 'webhook.delivered'; return <tr key={row.id}><td><span className={`pay-status-badge ${ok ? 'st-paid' : 'st-declined'}`}>{ok ? 'Delivered' : 'Failed'}</span></td><td className="mono">{row.entity_id ?? '—'}</td><td className="mono">{row.after?.destination_host ?? '—'}</td><td className="mono">{row.after?.status ?? row.after?.error ?? '—'}{row.after?.latency_ms != null ? ` · ${row.after.latency_ms} ms` : ''}</td><td className="mono">{when(row.created_at)}</td></tr> })}
      {data && data.webhooks.length === 0 && <tr><td colSpan={5} className="sidebar-hint">{t('لا توجد محاولات Callback مسجلة خلال 24 ساعة.', 'No callback attempts recorded in the last 24 hours.')}</td></tr>}
    </tbody></table></div></section>

    <section className="card recent-card"><div className="recent-head"><h3>{t('نبض الأجهزة', 'Device heartbeat')}</h3><Link to="/wallets" className="pay-status-link">{t('فتح الأجهزة ←', 'Open devices →')}</Link></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الجهاز', 'Device')}</th><th>{t('الحالة', 'Status')}</th><th>{t('البطارية', 'Battery')}</th><th>{t('الشبكة', 'Network')}</th><th>{t('آخر نبض', 'Last heartbeat')}</th></tr></thead><tbody>
      {(data?.devices ?? []).map((d) => <tr key={`${d.device}:${d.sim_slot ?? ''}`}><td className="mono">{d.device}{d.sim_slot != null ? ` · SIM ${d.sim_slot}` : ''}</td><td><span className={`pay-status-badge ${d.online ? 'st-paid' : 'st-declined'}`}>{d.online ? t('متصل', 'Online') : t('غير متصل', 'Offline')}</span></td><td className="mono">{d.battery == null ? '—' : `${d.battery}%${d.charging ? ' ⚡' : ''}`}</td><td>{d.net_type ?? '—'}</td><td className="mono">{when(d.last_seen_at)}</td></tr>)}
    </tbody></table></div></section>
  </PanelShell>
}
