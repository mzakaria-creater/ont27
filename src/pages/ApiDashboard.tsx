import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Clock3, Database, Download, ExternalLink, RefreshCw, Server, WalletCards, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'

type Provider = { count24h: number; pending: number; lastChange: string | null; latestTransaction?: string | null; stale?: boolean }
type Tx = { tx_id: number; ontarget_ref: string | null; status: string; amount: number | null; currency: string | null; merchant: string | null; gateway: string | null; first_seen_at: string | null }
type Data = { generatedAt: string; lastSync: string | null; api: { ok: boolean; latencyMs: number }; supabase: { ok: boolean; latencyMs: number; failedSources: string[] }; queues: { pendingDeposits: number | null; pendingPayouts: number | null; editRequests: number | null }; providers: Record<string, Provider>; transactions: Tx[]; devices: { online: boolean | null }[] }
type RailwayStatus = { connected: boolean; baseUrl: string; docsUrl: string; version: string | null; remoteTimestamp: string | null; latencyMs: number | null; apiKeyConfigured: boolean; protectedAccess: boolean | null }

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
  const [railway, setRailway] = useState<RailwayStatus | null>(null)
  const load = useCallback(async () => { setLoading(true); try { const [monitoring, railwayStatus] = await Promise.all([api<Data>('/api/monitoring'), api<RailwayStatus>('/api/railway/status')]); setData(monitoring); setRailway(railwayStatus); setError(false) } catch { setError(true) } finally { setLoading(false) } }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer) }, [load])
  const stats = useMemo(() => {
    const rows = data?.transactions ?? []
    return { total: rows.length, approved: rows.filter((r)=>['PAID','APPROVED'].includes(r.status)).length, pending: rows.filter((r)=>r.status==='PENDING').length, declined: rows.filter((r)=>r.status==='DECLINED').length }
  }, [data])
  const online = data?.devices.filter((d)=>d.online).length ?? 0
  const exportXlsx = async () => {
    if (!data?.transactions.length) return
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'OnTarget'; workbook.created = new Date()
    const sheet = workbook.addWorksheet('Transactions', { views: [{ state: 'frozen', ySplit: 1 }] })
    sheet.columns = [
      { header: 'Our TRX', key: 'ourTrx', width: 20 }, { header: 'Provider Transaction ID', key: 'txId', width: 22 },
      { header: 'Merchant', key: 'merchant', width: 28 }, { header: 'Gateway', key: 'gateway', width: 20 },
      { header: 'Amount', key: 'amount', width: 14 }, { header: 'Currency', key: 'currency', width: 11 },
      { header: 'Status', key: 'status', width: 14 }, { header: 'Created UTC', key: 'created', width: 24 },
    ]
    data.transactions.forEach((row) => sheet.addRow({ ourTrx: row.ontarget_ref ?? '', txId: row.tx_id, merchant: row.merchant ?? '', gateway: row.gateway ?? '', amount: Number(row.amount ?? 0), currency: row.currency ?? '', status: row.status, created: row.first_seen_at ? new Date(row.first_seen_at) : '' }))
    sheet.getRow(1).font = { bold: true, color: { argb: 'FF111827' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7B84B' } }; sheet.autoFilter = { from: 'A1', to: 'H1' }
    sheet.getColumn('amount').numFmt = '#,##0.00'; sheet.getColumn('created').numFmt = 'yyyy-mm-dd hh:mm:ss'
    const bytes = await workbook.xlsx.writeBuffer()
    const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `ontarget-transactions-${new Date().toISOString().slice(0,10)}.xlsx`; anchor.click(); URL.revokeObjectURL(url)
  }

  return <PanelShell>
    <section className="api-dash-head"><div><span>ONTARGET · OPERATIONS API</span><h2>API Dashboard</h2><p>Live platform health, transaction flow, and operational tools in one authenticated workspace.</p></div><div className="api-dash-actions"><button className="btn-ghost btn-sm" disabled={!data?.transactions.length} onClick={()=>void exportXlsx()}><Download size={15}/>Export XLSX</button><button className="btn-primary btn-sm" disabled={loading} onClick={()=>void load()}><RefreshCw size={15} className={loading?'spin':''}/>Refresh</button></div></section>
    {error&&<div className="card warn">The monitoring API could not be reached. Existing operational pages remain available.</div>}

    <section className="api-health-grid">
      <article className="api-health-card"><Server/><div><small>Live API</small><strong className={data?.api.ok?'ok':'bad'}>{data?.api.ok?'Healthy':'Unavailable'}</strong><span>{data ? `${data.api.latencyMs} ms` : 'Checking…'}</span></div></article>
      <article className="api-health-card"><Database/><div><small>Supabase DB</small><strong className={data?.supabase.ok?'ok':'bad'}>{data?.supabase.ok?'Healthy':'Degraded'}</strong><span>{data ? `${data.supabase.latencyMs} ms` : 'Checking…'}</span></div></article>
      <article className="api-health-card"><Activity/><div><small>Provider sync</small><strong className="ok">Live</strong><span>{when(data?.lastSync ?? null)}</span></div></article>
      <article className="api-health-card"><WalletCards/><div><small>Device coverage</small><strong>{online}/{data?.devices.length ?? 0}</strong><span>devices online</span></div></article>
    </section>

    <section className="card api-provider-strip">
      <div><span>Railway API</span><strong className={railway?.connected?'ok':'bad'}>{railway?.connected?'Connected':'Unavailable'}</strong><small>{railway?.latencyMs == null?'Checking…':`${railway.latencyMs} ms · v${railway.version??'—'}`}</small></div>
      <div><span>Protected API access</span><strong className={railway?.protectedAccess?'ok':railway?.apiKeyConfigured?'bad':'gold'}>{railway?.protectedAccess?'Authorized':railway?.apiKeyConfigured?'Invalid key':'Key required'}</strong><small>Server-side credential only</small></div>
      <div><span>API base</span><strong className="api-generated">api.ontarget-egy.com</strong><small>{railway?.remoteTimestamp?`Checked ${when(railway.remoteTimestamp)}`:'Live Railway service'}</small></div>
      <div><span>Documentation</span><a className="pay-status-link" href={railway?.docsUrl??'https://api.ontarget-egy.com/docs'} target="_blank" rel="noreferrer">Open Swagger <ExternalLink size={13}/></a><small>Live OpenAPI specification</small></div>
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

    <section className="card api-provider-strip"><div><span>NagoPay / NGPay</span><strong>{data?.providers.nagopay?.count24h??'—'}</strong><small>{data?.providers.nagopay?.pending??'—'} pending · 24h</small></div><div><span>PayFuture {data?.providers.payfuture?.stale ? '⚠ stale' : '● live'}</span><strong>{data?.providers.payfuture?.count24h??'—'}</strong><small>{data?.providers.payfuture?.pending??'—'} pending · 24h · last {when(data?.providers.payfuture?.latestTransaction ?? null)}</small></div><div><span>Edit requests</span><strong>{data?.queues.editRequests??'—'}</strong><small>awaiting review</small></div><div><span>Generated</span><strong className="api-generated"><Clock3 size={15}/>{when(data?.generatedAt??null)}</strong><small>auto-refresh every 15 seconds</small></div></section>
  </PanelShell>
}
