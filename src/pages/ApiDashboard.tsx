import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Clock3, Database, ExternalLink, RefreshCw, Server, WalletCards, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'

type Provider = { count24h: number; pending: number; lastChange: string | null }
type Tx = { tx_id: number; ontarget_ref: string | null; status: string; amount: number | null; currency: string | null; merchant: string | null; gateway: string | null; first_seen_at: string | null }
type Data = { generatedAt: string; lastSync: string | null; api: { ok: boolean; latencyMs: number }; supabase: { ok: boolean; latencyMs: number; failedSources: string[] }; queues: { pendingDeposits: number | null; pendingPayouts: number | null; editRequests: number | null }; providers: Record<string, Provider>; transactions: Tx[]; devices: { online: boolean | null }[] }

const modules = [
  ['/admin-transactions', 'Transactions', 'Full administrative transaction ledger'], ['/approvals', 'Approvals', 'Pending deposit decisions'],
  ['/merchants', 'Merchants', 'Merchant accounts and performance'], ['/settlements', 'Settlements', 'Settlement requests and reconciliation'],
  ['/wallets', 'Wallets', 'Capacity and allocation engine'], ['/payment-methods', 'Payment methods', 'Channels and assigned accounts'],
  ['/analytics-dashboard', 'Analytics', 'Live performance and conversion'], ['/sms', 'SMS logs', 'Realtime messages and matching'],
  ['/merchant-link-generator', 'Checkout', 'Payment links and conversion'], ['/admin', 'Access control', 'Users, roles, API keys and permissions'],
] as const
const when = (value: string | null) => value ? new Date(value).toLocaleString() : '—'

export default function ApiDashboard() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const load = useCallback(async () => { setLoading(true); try { setData(await api<Data>('/api/monitoring')); setError(false) } catch { setError(true) } finally { setLoading(false) } }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer) }, [load])
  const stats = useMemo(() => {
    const rows = data?.transactions ?? []
    return { total: rows.length, approved: rows.filter((r)=>['PAID','APPROVED'].includes(r.status)).length, pending: rows.filter((r)=>r.status==='PENDING').length, declined: rows.filter((r)=>r.status==='DECLINED').length }
  }, [data])
  const online = data?.devices.filter((d)=>d.online).length ?? 0

  return <PanelShell>
    <section className="api-dash-head"><div><span>ONTARGET · OPERATIONS API</span><h2>API Dashboard</h2><p>Live platform health, transaction flow, and operational tools in one authenticated workspace.</p></div><button className="btn-primary btn-sm" disabled={loading} onClick={()=>void load()}><RefreshCw size={15} className={loading?'spin':''}/>Refresh</button></section>
    {error&&<div className="card warn">The monitoring API could not be reached. Existing operational pages remain available.</div>}

    <section className="api-health-grid">
      <article className="api-health-card"><Server/><div><small>Live API</small><strong className={data?.api.ok?'ok':'bad'}>{data?.api.ok?'Healthy':'Unavailable'}</strong><span>{data ? `${data.api.latencyMs} ms` : 'Checking…'}</span></div></article>
      <article className="api-health-card"><Database/><div><small>Supabase DB</small><strong className={data?.supabase.ok?'ok':'bad'}>{data?.supabase.ok?'Healthy':'Degraded'}</strong><span>{data ? `${data.supabase.latencyMs} ms` : 'Checking…'}</span></div></article>
      <article className="api-health-card"><Activity/><div><small>Provider sync</small><strong className="ok">Live</strong><span>{when(data?.lastSync ?? null)}</span></div></article>
      <article className="api-health-card"><WalletCards/><div><small>Device coverage</small><strong>{online}/{data?.devices.length ?? 0}</strong><span>devices online</span></div></article>
    </section>

    <section className="api-metric-grid">
      <article><small>Recent transactions</small><strong>{stats.total}</strong><Activity/></article>
      <article><small>Pending</small><strong className="gold">{data?.queues.pendingDeposits ?? stats.pending}</strong><Clock3/></article>
      <article><small>Approved</small><strong className="green">{stats.approved}</strong><CheckCircle2/></article>
      <article><small>Declined</small><strong className="red">{stats.declined}</strong><XCircle/></article>
    </section>

    <div className="api-dash-layout">
      <section className="card recent-card"><div className="recent-head"><div><h3>Recent transactions</h3><span className="cell-sub">Live monitoring sample</span></div><Link className="pay-status-link" to="/admin-transactions">Open ledger →</Link></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Our TRX</th><th>Provider ID</th><th>Merchant</th><th>Gateway</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead><tbody>{(data?.transactions??[]).slice(0,12).map((row)=><tr key={row.tx_id}><td className="mono">{row.ontarget_ref??'—'}</td><td className="mono">{row.tx_id}</td><td>{row.merchant??'—'}</td><td>{row.gateway??'—'}</td><td className="mono">{money(row.amount,row.currency)}</td><td><span className={`pay-status-badge ${['PAID','APPROVED'].includes(row.status)?'st-paid':row.status==='DECLINED'?'st-declined':'st-pending'}`}>{row.status}</span></td><td className="mono">{when(row.first_seen_at)}</td></tr>)}{data&&data.transactions.length===0&&<tr><td colSpan={7}>No recent transactions.</td></tr>}</tbody></table></div></section>
      <aside className="card api-module-card"><div className="recent-head"><div><h3>Platform modules</h3><span className="cell-sub">Merged from the supplied API console</span></div></div><div className="api-module-list">{modules.map(([to,title,description])=><Link key={to} to={to}><div><strong>{title}</strong><span>{description}</span></div><ExternalLink size={14}/></Link>)}</div></aside>
    </div>

    <section className="card api-provider-strip"><div><span>NagoPay / NGPay</span><strong>{data?.providers.nagopay?.count24h??'—'}</strong><small>{data?.providers.nagopay?.pending??'—'} pending · 24h</small></div><div><span>PayFuture</span><strong>{data?.providers.payfuture?.count24h??'—'}</strong><small>{data?.providers.payfuture?.pending??'—'} pending · 24h</small></div><div><span>Edit requests</span><strong>{data?.queues.editRequests??'—'}</strong><small>awaiting review</small></div><div><span>Generated</span><strong className="api-generated"><Clock3 size={15}/>{when(data?.generatedAt??null)}</strong><small>auto-refresh every 15 seconds</small></div></section>
  </PanelShell>
}
