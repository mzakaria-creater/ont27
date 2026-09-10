import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Download, RefreshCw } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import PageSizeSelect from '../components/PageSizeSelect'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'

interface Row {
  id: number; received_at: string | null; device_name: string | null; sim_slot: number | null
  wallet: string | null; provider: string | null; amount: number | null; balance_after: number | null
  linked: boolean; match_status: string | null; consumed_by_tx_id: number | null
  matched_transaction_id: number | null; trx_id: string | null; trx_reference: string | null
  sender_name: string | null; sms_first_line: string | null
}
interface GroupKpi { key: string; label: string; count: number; amount: number; linked: number; unlinked: number; latest_balance: number | null }
interface ReportData {
  rows: Row[]; total: number; limit: number; offset: number; providers: string[]
  kpis: { count: number; amount: number; linked: number; unlinked: number; coverage: number; wallets: number; wallet_used: number; with_balance: number; sms_out: number; sms_out_amount: number; payout_amount: number; usdt_payout: number; cash_payout: number; other_payout: number }
  wallet_kpis: GroupKpi[]; sender_kpis: GroupKpi[]; cash_sender_kpis: GroupKpi[]
}
const dateValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export default function WithdrawalSmsReport() {
  const { t } = useLocale()
  const [pageSize, setPageSize] = usePageSize('withdrawal-sms-report')
  const [page, setPage] = useState(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [wallet, setWallet] = useState('')
  const [provider, setProvider] = useState('')
  const [link, setLink] = useState('')
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState({ from: '', to: '', wallet: '', provider: '', link: '', q: '' })
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const search = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
    for (const [key, value] of Object.entries(applied)) if (value) search.set(key, value)
    try { setData(await api<ReportData>(`/api/reports/withdrawal-sms?${search}`)) }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التقرير.', 'You lack permission to view this report.') : t('تعذّر تحميل تقرير رسائل السحب.', 'Failed to load withdrawal SMS report.')) }
    finally { setLoading(false) }
  }, [applied, page, pageSize, t])
  useEffect(() => { void load() }, [load])

  const applyPreset = (kind: 'today' | 'week' | 'month') => {
    const end = new Date(); const start = new Date(end)
    if (kind === 'week') start.setDate(end.getDate() - ((end.getDay() + 6) % 7))
    if (kind === 'month') start.setDate(1)
    setFrom(dateValue(start)); setTo(dateValue(end))
  }
  const applyFilters = () => { setPage(1); setApplied({ from, to, wallet: wallet.trim(), provider, link, q: q.trim() }) }
  const reset = () => { setFrom(''); setTo(''); setWallet(''); setProvider(''); setLink(''); setQ(''); setPage(1); setApplied({ from: '', to: '', wallet: '', provider: '', link: '', q: '' }) }
  const exportCsv = () => {
    if (!data) return
    const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = [['SMS ID','Time','Wallet','Provider','Amount','Balance after','Linked','Transaction reference'], ...data.rows.map((row) => [row.id,row.received_at,row.wallet,row.provider,row.amount,row.balance_after,row.linked ? 'linked' : 'unlinked',row.trx_id ?? row.trx_reference ?? row.consumed_by_tx_id ?? row.matched_transaction_id])]
    const blob = new Blob([rows.map((row) => row.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'withdrawal-sms-report.csv'; a.click(); URL.revokeObjectURL(url)
  }
  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1
  const k = data?.kpis

  return <PanelShell>
    <section className="page-head withdrawal-report-head">
      <div><h2>{t('تقرير رسائل السحب', 'Withdrawal SMS report')}</h2><p className="page-sub">{t('حركة WD، تغطية الربط، الرصيد والمحافظ في نطاق زمني واحد.', 'WD activity, matching coverage, balances and wallets in one date scope.')}</p></div>
      <button className="btn-ghost btn-sm icon-text-btn" disabled={!data} onClick={exportCsv}><Download size={15}/>{t('تصدير الصفحة', 'Export page')}</button>
    </section>

    <section className="withdrawal-kpi-grid">
      <div className="kpi-card"><div className="kpi-value">{k ? k.wallet_used.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('المحافظ المستخدمة', 'Wallets used')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? k.sms_out.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('إجمالي SMS الخارج', 'Total outbound SMS')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? money(k.sms_out_amount, 'EGP') : '…'}</div><div className="kpi-label">{t('إجمالي مبلغ SMS الخارج', 'Outbound SMS amount')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? money(k.payout_amount, 'EGP') : '…'}</div><div className="kpi-label">{t('إجمالي السحوبات', 'Total payouts')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? money(k.usdt_payout, 'EGP') : '…'}</div><div className="kpi-label">USDT payout</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? money(k.cash_payout, 'EGP') : '…'}</div><div className="kpi-label">{t('سحب كاش', 'Cash payout')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? k.linked.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('مرتبطة', 'Linked')}</div></div>
      <div className="kpi-card stat-pending"><div className="kpi-value">{k ? k.unlinked.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('غير مرتبطة', 'Unlinked')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? `${k.coverage.toFixed(1)}%` : '…'}</div><div className="kpi-label">{t('تغطية الربط', 'Match coverage')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{k ? k.wallets.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('محافظ نشطة', 'Active wallets')}</div></div>
    </section>
    {data && <section className="withdrawal-group-kpis">
      <div className="card withdrawal-group-card"><div className="recent-head"><h3>👛 {t('KPI حسب محفظة الاستلام','Receiver wallet KPIs')}</h3><span className="cell-sub">{data.wallet_kpis.length} {t('محفظة','wallets')}</span></div><div className="withdrawal-group-list">{data.wallet_kpis.slice(0,12).map((g)=><div className="withdrawal-group-row" key={g.key}><div><strong className="mono">{g.label}</strong><span className="cell-sub">{g.count} SMS · {g.linked} {t('مرتبطة','linked')} · {g.unlinked} {t('غير مرتبطة','unlinked')}</span></div><strong className="mono">{money(g.amount,'EGP')}</strong></div>)}{!data.wallet_kpis.length&&<span className="cell-sub">{t('لا توجد بيانات','No data')}</span>}</div></div>
      <div className="card withdrawal-group-card"><div className="recent-head"><h3>👤 {t('KPI حسب المرسل','Sender KPIs')}</h3><span className="cell-sub">{data.sender_kpis.length} {t('مرسل','senders')}</span></div><div className="withdrawal-group-list">{data.sender_kpis.slice(0,12).map((g)=><div className="withdrawal-group-row" key={g.key}><div><strong>{g.label}</strong><span className="cell-sub">{g.count} SMS · {g.linked} {t('مرتبطة','linked')} · {g.unlinked} {t('غير مرتبطة','unlinked')}</span></div><strong className="mono">{money(g.amount,'EGP')}</strong></div>)}{!data.sender_kpis.length&&<span className="cell-sub">{t('لا توجد بيانات','No data')}</span>}</div></div>
      <div className="card withdrawal-group-card"><div className="recent-head"><h3>💵 {t('الكاش المستلم حسب الاسم','Cash received by name')}</h3><span className="cell-sub">{t('اسم المستلم من SMS الخارج','Recipient name from outbound SMS')}</span></div><div className="withdrawal-group-list">{data.cash_sender_kpis.slice(0,12).map((g)=><div className="withdrawal-group-row" key={g.key}><div><strong>{g.label}</strong><span className="cell-sub">{g.count} SMS · {g.linked} {t('مرتبطة','linked')}</span></div><strong className="mono">{money(g.amount,'EGP')}</strong></div>)}{!data.cash_sender_kpis.length&&<span className="cell-sub">{t('لا توجد بيانات','No data')}</span>}</div></div>
    </section>}

    <section className="card withdrawal-report-filters transaction-filter-toolbar">
      <div className="payout-filter-presets"><button className="btn-ghost btn-sm" onClick={() => applyPreset('today')}>{t('اليوم','Today')}</button><button className="btn-ghost btn-sm" onClick={() => applyPreset('week')}>{t('هذا الأسبوع','This week')}</button><button className="btn-ghost btn-sm" onClick={() => applyPreset('month')}>{t('هذا الشهر','This month')}</button></div>
      <form className="withdrawal-filter-grid" onSubmit={(e) => { e.preventDefault(); applyFilters() }}>
        <label>{t('من','From')}<input className="login-input" type="date" value={from} max={to || undefined} onChange={(e)=>setFrom(e.target.value)}/></label>
        <label>{t('إلى','To')}<input className="login-input" type="date" value={to} min={from || undefined} onChange={(e)=>setTo(e.target.value)}/></label>
        <label>{t('المحفظة','Wallet')}<input className="login-input mono" value={wallet} onChange={(e)=>setWallet(e.target.value)}/></label>
        <label>{t('المزوّد','Provider')}<select className="login-input" value={provider} onChange={(e)=>setProvider(e.target.value)}><option value="">{t('الكل','All')}</option>{(data?.providers ?? []).map((item)=><option key={item}>{item}</option>)}</select></label>
        <label>{t('حالة الربط','Link status')}<select className="login-input" value={link} onChange={(e)=>setLink(e.target.value)}><option value="">{t('الكل','All')}</option><option value="linked">{t('مرتبطة','Linked')}</option><option value="unlinked">{t('غير مرتبطة','Unlinked')}</option></select></label>
        <label>{t('بحث','Search')}<input className="login-input" value={q} onChange={(e)=>setQ(e.target.value)} placeholder="TRX / name / SMS"/></label>
        <button className="btn-primary btn-sm" type="submit">{t('تطبيق','Apply')}</button><button className="btn-ghost btn-sm" type="button" onClick={reset}>{t('إعادة ضبط','Reset')}</button><button className="btn-ghost btn-sm icon-text-btn" type="button" disabled={loading} onClick={()=>void load()}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{t('تحديث','Refresh')}</button>
      </form>
      {(applied.from || applied.to) && <span className="cell-sub icon-text-btn"><CalendarDays size={14}/>{applied.from || '…'} → {applied.to || '…'}</span>}
    </section>

    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {loading && <p className="sidebar-hint">{t('جارٍ تحميل التقرير…','Loading report…')}</p>}
      {!loading && data?.rows.length === 0 && <p>{t('لا توجد رسائل سحب مطابقة للفلاتر.','No withdrawal SMS match these filters.')}</p>}
      {!loading && data && data.rows.length > 0 && <div className="table-wrap"><table className="data-table withdrawal-report-table"><thead><tr><th>SMS ID</th><th>{t('الوقت','Time')}</th><th>{t('المحفظة','Wallet')}</th><th>{t('المزوّد','Provider')}</th><th>{t('المبلغ','Amount')}</th><th>{t('الرصيد بعد','Balance after')}</th><th>{t('الربط','Link')}</th><th>TRX</th><th>{t('الجهاز','Device')}</th></tr></thead><tbody>{data.rows.map((row)=><tr key={row.id} className={!row.linked ? 'withdrawal-unlinked-row' : undefined}><td className="mono">#{row.id}</td><td className="mono">{depositTime({ first_seen_at: row.received_at })}</td><td className="mono">{row.wallet ?? '—'}</td><td>{row.provider ?? '—'}</td><td className="mono">{money(row.amount,'EGP')}</td><td className="mono">{money(row.balance_after,'EGP')}</td><td><span className={`pay-status-badge ${row.linked ? 'st-paid' : 'st-pending'}`}>{row.linked ? t('مرتبطة','Linked') : t('غير مرتبطة','Unlinked')}</span>{row.match_status && <div className="cell-sub">{row.match_status}</div>}</td><td className="mono">{row.trx_id ?? row.trx_reference ?? row.consumed_by_tx_id ?? row.matched_transaction_id ?? '—'}</td><td>{row.device_name ?? '—'}{row.sim_slot != null && <div className="cell-sub">SIM {row.sim_slot}</div>}</td></tr>)}</tbody></table></div>}
      {data && totalPages > 1 && <div className="pager"><button className="btn-ghost btn-sm" disabled={page<=1} onClick={()=>setPage(page-1)}>{t('السابق','Prev')}</button><PageSizeSelect value={pageSize} onChange={(size)=>{setPageSize(size);setPage(1)}}/><span className="pager-info mono">{page} / {totalPages}</span><button className="btn-ghost btn-sm" disabled={page>=totalPages} onClick={()=>setPage(page+1)}>{t('التالي','Next')}</button></div>}
    </section>
  </PanelShell>
}
