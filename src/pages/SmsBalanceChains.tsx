import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw, Search } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useIsMobile } from '../lib/useIsMobile'

type ChainRow = {
  sms_id: number; prev_sms_id: number; chain_root: number; wallet: string | null; inferred_wallet: string | null
  evidence_tx_links: number; received_at: string | null; device: string | null; sim_slot: string | null; provider: string | null
  amount: number | null; previous_balance: number | null; current_balance: number | null; delta: number | null; expected_delta: number | null
  difference: number | null; continuity: 'ok' | 'warning' | 'unknown'; matched_transaction_id: number | null; webhook_name: string | null
}
type Response = { rows: ChainRow[]; total: number; kpis: { chains: number; wallets: number; evidence_links: number; warnings: number }; options: { providers: string[]; devices: string[] } }

const cairoTime = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }) : '—'
const label = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export default function SmsBalanceChains() {
  const isMobile = useIsMobile()
  const [data, setData] = useState<Response | null>(null)
  const [query, setQuery] = useState('')
  const [providers, setProviders] = useState<string[]>([])
  const [devices, setDevices] = useState<string[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '500', q: query, provider: providers.join(','), device: devices.join(','), status })
      if (from) params.set('from', from); if (to) params.set('to', to)
      setData(await api<Response>(`/api/sms-balance-chains?${params}`)); setError(null)
    } catch (e) { setError(e instanceof ApiError && e.status === 403 ? 'You do not have permission to view SMS balance chains.' : 'Failed to load SMS balance chains.') }
    finally { setLoading(false) }
  }, [query, providers, devices, from, to, status])
  useEffect(() => { void load() }, [load])

  const rows = data?.rows ?? []
  const providerOptions = useMemo(() => (data?.options.providers ?? []).map((value) => ({ value, label: label(value) })), [data])
  const deviceOptions = useMemo(() => (data?.options.devices ?? []).map((value) => ({ value, label: value.toUpperCase() })), [data])
  const reset = () => { setQuery(''); setProviders([]); setDevices([]); setFrom(''); setTo(''); setStatus('all') }

  return <PanelShell>
    <section className="page-head">
      <h2><GitBranch size={22} /> SMS balance chains</h2>
      <p className="page-sub">Trace each SMS to the previous wallet balance and detect continuity warnings.</p>
    </section>
    <div className="kpi-grid">
      <div className="kpi-card"><div className="kpi-value">{data?.kpis.chains ?? '…'}</div><div className="kpi-label">Chain rows</div></div>
      <div className="kpi-card"><div className="kpi-value">{data?.kpis.wallets ?? '…'}</div><div className="kpi-label">Wallets</div></div>
      <div className="kpi-card"><div className="kpi-value">{data?.kpis.evidence_links ?? '…'}</div><div className="kpi-label">Transaction links</div></div>
      <div className="kpi-card stat-pending"><div className="kpi-value">{data?.kpis.warnings ?? '…'}</div><div className="kpi-label">Continuity warnings</div></div>
    </div>
    <div className="filter-bar transaction-filter-toolbar">
      <label className="wallet-report-search"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SMS, wallet, chain…" /></label>
      {providerOptions.length > 0 && <MultiSelectFilter label="Provider" allLabel="All providers" options={providerOptions} value={providers} onChange={setProviders} />}
      {deviceOptions.length > 0 && <MultiSelectFilter label="Device" allLabel="All devices" options={deviceOptions} value={devices} onChange={setDevices} />}
      <input className="login-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
      <input className="login-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
      <select className="login-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Continuity status"><option value="all">All continuity</option><option value="ok">OK</option><option value="warning">Warning</option><option value="unknown">Unknown</option></select>
      <button className="btn-ghost btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
      <button className="btn-ghost btn-sm" onClick={reset}>Reset</button>
    </div>
    {error && <div className="card warn">{error}</div>}
    <section className="card recent-card">
      {loading && !data ? <p className="sidebar-hint">Loading balance chains…</p> : rows.length === 0 ? <p className="sidebar-hint">No SMS balance chains match the selected filters.</p> : isMobile ? <div className="risk-card-list">{rows.map((row) => <div key={`${row.sms_id}-${row.prev_sms_id}`} className="risk-row-card">
        <div className="risk-row-card-head"><Link to={`/sms?q=${row.sms_id}`} className="mono">#{row.sms_id}</Link>{row.continuity === 'ok' ? <span className="pay-status-badge st-paid"><CheckCircle2 size={13} /> OK</span> : row.continuity === 'warning' ? <span className="pay-status-badge st-declined"><AlertTriangle size={13} /> Warning</span> : <span className="pay-status-badge st-pending">Unknown</span>}</div>
        <div className="cell-sub">{row.wallet ?? row.inferred_wallet ?? '—'} · {row.provider ?? '—'} · {row.device?.toUpperCase() ?? '—'}{row.sim_slot && ` SIM ${row.sim_slot}`}</div>
        <div className="cell-sub mono">{money(row.amount, 'EGP')} · prev {money(row.previous_balance, 'EGP')} → now {money(row.current_balance, 'EGP')} · Δ {money(row.delta, 'EGP')} (exp {money(row.expected_delta, 'EGP')})</div>
        <div className="risk-row-card-foot">
          <span>{row.evidence_tx_links > 0 ? <span className="positive-text">{row.evidence_tx_links} trx</span> : '—'}{row.matched_transaction_id && <> · <Link to={`/transactions/${row.matched_transaction_id}`}>#{row.matched_transaction_id}</Link></>}</span>
          <span className="mono muted">{cairoTime(row.received_at)}</span>
        </div>
      </div>)}</div> : <div className="table-wrap"><table className="data-table"><thead><tr>
        <th>SMS / Previous</th><th>Chain root</th><th>Wallet</th><th>Provider</th><th>Device / SIM</th><th>Amount</th><th>Previous balance</th><th>Current balance</th><th>Delta / expected</th><th>Evidence</th><th>Received</th><th>Continuity</th>
      </tr></thead><tbody>{rows.map((row) => <tr key={`${row.sms_id}-${row.prev_sms_id}`}>
        <td className="mono"><Link to={`/sms?q=${row.sms_id}`}>#{row.sms_id}</Link><div className="cell-sub">prev #{row.prev_sms_id}</div></td>
        <td className="mono">#{row.chain_root}</td><td className="mono">{row.wallet ?? row.inferred_wallet ?? '—'}</td>
        <td>{row.provider ?? '—'}</td><td>{row.device?.toUpperCase() ?? '—'}{row.sim_slot && <div className="cell-sub">SIM {row.sim_slot}</div>}</td>
        <td className="mono">{money(row.amount, 'EGP')}</td><td className="mono">{money(row.previous_balance, 'EGP')}</td><td className="mono">{money(row.current_balance, 'EGP')}</td>
        <td className="mono">{money(row.delta, 'EGP')}<div className="cell-sub">expected {money(row.expected_delta, 'EGP')}</div></td>
        <td>{row.evidence_tx_links > 0 ? <span className="positive-text">{row.evidence_tx_links} trx</span> : '—'}{row.matched_transaction_id && <div className="cell-sub"><Link to={`/transactions/${row.matched_transaction_id}`}>#{row.matched_transaction_id}</Link></div>}</td>
        <td className="mono">{cairoTime(row.received_at)}</td>
        <td>{row.continuity === 'ok' ? <span className="pay-status-badge st-paid"><CheckCircle2 size={13} /> OK</span> : row.continuity === 'warning' ? <span className="pay-status-badge st-declined"><AlertTriangle size={13} /> Warning</span> : <span className="pay-status-badge st-pending">Unknown</span>}</td>
      </tr>)}</tbody></table></div>}
      {data && <div className="cell-sub" style={{ padding: '12px 0 0' }}>Showing {rows.length} of {data.total} matching chain rows.</div>}
    </section>
  </PanelShell>
}
