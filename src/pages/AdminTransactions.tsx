import { Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Search, X } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MethodLogo from '../components/MethodLogo'
import SenderIdentity from '../components/SenderIdentity'
import ProofIconButton from '../components/ProofIconButton'
import ProofModal from '../components/ProofModal'
import TransactionEditDialog from '../components/TransactionEditDialog'
import { api, ApiError } from '../lib/api'
import { money, statusMeta } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'

type Row = Record<string, unknown> & { tx_id: number; status: string; amount: number | null; ontarget_ref?: string | null }
type Summary = { volume: number; pending: number; paid: number; declined: number }
const text = (row: Row, ...keys: string[]) => { for (const key of keys) if (row[key] != null && row[key] !== '') return String(row[key]); return '—' }
const rawValue = (row: Row, ...keys: string[]) => { const raw = row.maven_raw_row as Record<string, unknown> | null; for (const key of keys) { if (row[key] != null && row[key] !== '') return String(row[key]); if (raw?.[key] != null && raw[key] !== '') return String(raw[key]) } return '—' }
const proofUrl = (row: Row) => {
  const raw = row.maven_raw_row as Record<string, unknown> | null
  const imageUrl = row.image_url ?? row.proof_url ?? raw?.ImageUrl ?? raw?.imageUrl
  if (Array.isArray(imageUrl)) return typeof imageUrl[0] === 'string' ? imageUrl[0] : null
  if (typeof imageUrl === 'string' && imageUrl.startsWith('http')) return imageUrl
  const fx = row.fx ?? raw?.Fx
  return typeof fx === 'string' && fx ? `https://mavenconsulanting-co.s3.af-south-1.amazonaws.com/P2P-SS/${encodeURIComponent(fx)}` : null
}

export default function AdminTransactions() {
  const { can } = useAuth()
  const [rows, setRows] = useState<Row[]>([]); const [total, setTotal] = useState(0); const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary>({ volume: 0, pending: 0, paid: 0, declined: 0 })
  const [error, setError] = useState<string | null>(null); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [merchant, setMerchant] = useState(''); const [method, setMethod] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [sort, setSort] = useState('desc')
  const [applied, setApplied] = useState({ q: '', status: '', merchant: '', method: '', from: '', to: '', sort: 'desc' }); const [expanded, setExpanded] = useState<number | null>(null); const [busy, setBusy] = useState<number | null>(null); const [proof, setProof] = useState<{url:string; tx:number}|null>(null)
  const load = useCallback(async () => { setLoading(true); try { const p = new URLSearchParams({ limit: '100' }); Object.entries(applied).forEach(([k,v]) => v && p.set(k,v)); const res = await api<{rows: Row[]; total: number; summary: Summary}>(`/api/admin/transactions?${p}`); setRows(res.rows); setTotal(res.total); setSummary(res.summary); setError(null) } catch (e) { setError(e instanceof ApiError ? e.code : 'load_failed') } finally { setLoading(false) } }, [applied])
  useEffect(() => { void load() }, [load])
  const decide = async (row: Row, action: 'approve'|'decline') => { if (!confirm(`${action} #${row.tx_id}?`)) return; setBusy(row.tx_id); try { await api(`/api/deposits/${row.tx_id}/decision`, { method:'POST', body:JSON.stringify({ action, note:`Admin Transactions: ${action}` }) }); setRows((current)=>current.map((item)=>item.tx_id===row.tx_id?{...item,status:action==='approve'?'PAID':'DECLINED'}:item)) } catch(e) { setError(e instanceof ApiError ? e.code : 'decision_failed') } finally { setBusy(null) } }
  return <PanelShell>
    <section className="page-head"><h2>Admin Transactions</h2><p className="page-sub">Expanded administrative ledger · {total.toLocaleString()} records</p></section>
    <form className="filter-bar admin-trx-filter" onSubmit={(e)=>{e.preventDefault();setApplied({q:q.trim(),status,merchant:merchant.trim(),method,from,to,sort})}}>
      <label className="analytics-filter-search trx-search-bar"><Search size={16}/><input type="search" value={q} onChange={(e)=>setQ(e.target.value)} aria-label="Search admin transactions" placeholder="Amount, sender, phone, transaction, merchant ref, or user" />{q&&<button type="button" className="trx-search-clear" onClick={()=>setQ('')} aria-label="Clear search"><X size={15}/></button>}</label>
      <select className="filter-select" value={status} onChange={(e)=>setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING','PAID','APPROVED','DECLINED','EXPIRED','UNDERPAID'].map((v)=><option key={v}>{v}</option>)}</select>
      <select className="filter-select" value={method} onChange={(e)=>setMethod(e.target.value)}><option value="">All payment types</option>{['Mobile Wallet','Bank Account Transfer','InstaPay','P2P'].map((v)=><option key={v}>{v}</option>)}</select>
      <input className="login-input" value={merchant} onChange={(e)=>setMerchant(e.target.value)} placeholder="Merchant" aria-label="Merchant"/>
      <input className="login-input" type="date" value={from} onChange={(e)=>setFrom(e.target.value)} aria-label="From"/><input className="login-input" type="date" value={to} onChange={(e)=>setTo(e.target.value)} aria-label="To"/>
      <select className="filter-select" value={sort} onChange={(e)=>setSort(e.target.value)} aria-label="Date order"><option value="desc">Date: newest first</option><option value="asc">Date: oldest first</option></select>
      <button className="btn-primary btn-sm">Apply</button><button type="button" className="btn-ghost btn-sm" onClick={()=>{setQ('');setStatus('');setMerchant('');setMethod('');setFrom('');setTo('');setSort('desc');setApplied({q:'',status:'',merchant:'',method:'',from:'',to:'',sort:'desc'})}}>Reset</button><button type="button" className="btn-ghost btn-sm" onClick={()=>void load()}><RefreshCw size={14}/>Refresh</button>
    </form>
    <section className="kpi-grid" aria-live="polite">
      <div className="kpi-card"><div className="kpi-value">{loading ? '…' : total.toLocaleString('en-US')}</div><div className="kpi-label">Matching transactions</div><div className="cell-sub">Current filters and search</div></div>
      <div className="kpi-card"><div className="kpi-value">{loading ? '…' : money(summary.volume, 'EGP')}</div><div className="kpi-label">Filtered volume</div><div className="cell-sub">Current date range</div></div>
      <div className="kpi-card amber"><div className="kpi-value">{loading ? '…' : summary.pending.toLocaleString('en-US')}</div><div className="kpi-label">Pending</div><div className="cell-sub">Needs action</div></div>
      <div className="kpi-card"><div className="kpi-value">{loading ? '…' : summary.paid.toLocaleString('en-US')}</div><div className="kpi-label">Paid / approved</div><div className="cell-sub">Filtered success</div></div>
      <div className="kpi-card"><div className="kpi-value">{loading ? '…' : summary.declined.toLocaleString('en-US')}</div><div className="kpi-label">Declined</div><div className="cell-sub">Filtered failures</div></div>
    </section>
    {error&&<div className="card warn">{error}</div>}
    <section className="card recent-card admin-trx-card"><div className="table-wrap"><table className="data-table admin-trx-table"><thead><tr>{['Action','Our TRX No.','Transaction ID','Status','Payment Type','Amount','User Email','User Phone Number','Sender Account Name','Sender Account Number','Created UTC Date','Modified UTC Date','User Name','Merchant Ref ID','To Account Name','To Account Number','To Bank','Currency'].map((h)=><th key={h}>{h}</th>)}</tr></thead><tbody>
      {rows.map((r)=>{const st=statusMeta(r.status); const open=expanded===r.tx_id; const image=proofUrl(r); return <Fragment key={r.tx_id}>
        <tr className={r.status==='PENDING'?'row-pending':undefined}>
          <td><div className="admin-trx-actions"><button className="btn-ghost btn-sm" onClick={()=>setExpanded(open?null:r.tx_id)}>{open?<ChevronUp size={14}/>:<ChevronDown size={14}/>}</button>{image&&<ProofIconButton compact url={image} onOpen={(url)=>setProof({url,tx:r.tx_id})}/>} {r.status==='PENDING'&&can('deposits','can_approve')&&<><button className="btn-primary btn-sm" disabled={busy===r.tx_id} onClick={()=>void decide(r,'approve')}>Approve</button><button className="btn-ghost danger btn-sm" disabled={busy===r.tx_id} onClick={()=>void decide(r,'decline')}>Decline</button></>}<TransactionEditDialog txId={r.tx_id} ontargetRef={text(r,'ontarget_ref','tx_id')} status={r.status} amount={r.amount} currency={text(r,'currency')} gateway={text(r,'gateway')} onDone={()=>void load()}/></div></td>
          <td className="mono">{text(r,'ontarget_ref')}</td><td className="mono">{r.tx_id}</td><td><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></td><td><MethodLogo method={text(r,'payment_method')}/></td><td className="mono">{money(Number(r.amount??0),text(r,'currency'))}</td><td>{text(r,'email')}</td><td><SenderIdentity name={text(r,'sender_name')} phone={text(r,'sender_number')} /></td><td>{text(r,'sender_name')}</td><td className="mono">{text(r,'sender_account_number','sender_number')}</td><td className="mono">{text(r,'created_utc','first_seen_at')}</td><td className="mono">{text(r,'modified_utc','last_status_change')}</td><td>{rawValue(r,'user_name','UserName','sender_name')}</td><td className="mono">{text(r,'merchant_tx_reference')}</td><td>{text(r,'to_account_name')}</td><td className="mono">{text(r,'to_account_number')}</td><td>{text(r,'to_bank')}</td><td>{text(r,'currency')}</td>
        </tr>
        {open&&<tr key={`${r.tx_id}-details`} className="admin-trx-extra-row"><td colSpan={18}><dl>{[['Commission',rawValue(r,'commission','Commision','Commission')],['Commission %',rawValue(r,'commission_percentage','DepositPer','CommissionPercentage')],['Master Merchant',text(r,'master_merchant')],['Merchant',text(r,'merchant')],['Sub Merchant',rawValue(r,'sub_merchant','SiteName')],['PayBy',rawValue(r,'pay_by','PayBy')],['Request Type',rawValue(r,'request_type','RequestType')],['Gateway',rawValue(r,'gateway','Gateway')],['Response Message',rawValue(r,'response_message','Description','Response','GatewayResponseText')],['Agent Name',rawValue(r,'agent_name','AgentName')],['Account Name',rawValue(r,'account_name','AccountName','BankAccountName')],['Account Number',rawValue(r,'account_number','AccountNumber','BankAccountNumber')],['Bank Wallet Number',rawValue(r,'bank_wallet_number','BankWalletNumber')],['Descriptor',rawValue(r,'descriptor','Descriptor')],['Country',rawValue(r,'country','Country')],['State',rawValue(r,'state','State')],['City',rawValue(r,'city','City')],['Comment',rawValue(r,'comment','Comment')],['Provider GUID',rawValue(r,'guid','Guid')],['Proof file',rawValue(r,'fx','Fx')]].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></td></tr>}
      </Fragment>})}
      {!loading&&rows.length===0&&<tr><td colSpan={18}>No matching transactions.</td></tr>}
    </tbody></table></div></section>
    {proof&&<ProofModal url={proof.url} title={`Payment proof #${proof.tx}`} onClose={()=>setProof(null)}/>}
  </PanelShell>
}
