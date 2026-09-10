import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, RotateCcw, Search } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Wallet SMS report — per-wallet reconciliation (idea adapted from the old
// wallet-sms-report, rebuilt in the panel's own design). Each receiving wallet
// with its SMS volume, deposits, withdrawals, unconfirmed count, and balance.

interface WalletRow {
  wallet: string; device: string | null; merchant: string | null
  sms_count: number; sms_amount: number | null
  deposits_count: number; deposits_amount: number | null
  withdrawals_count: number; withdrawals_amount: number | null
  unconfirmed: number; balance: number | null; first_balance: number | null; last_sms: string | null
  provider?: string | null; sms_balance?: number | null; received?: number; sent?: number; transaction_count?: number
  avg_deposit?: number; avg_withdrawal?: number; today_profit?: number; daily_used?: number; monthly_used?: number
  daily_limit?: number; monthly_limit?: number; daily_remaining?: number; monthly_remaining?: number; daily_utilization_pct?: number; monthly_utilization_pct?: number; utilization_pct?: number; limit_warning?: string | null
}

// Balance diff = (balance change) − (deposits − withdrawals). Mirrors the old
// report's "Balance extra": SMS-reported activity vs the actual balance move.
// Large values are usually treasury sweeps out of the wallet, not errors.
function balanceDiff(r: WalletRow): number | null {
  if (r.sms_balance == null || r.first_balance == null) return null
  return Math.round(((r.sms_balance - r.first_balance) - ((r.deposits_amount ?? 0) - (r.withdrawals_amount ?? 0))) * 100) / 100
}

interface WalletSms { id: number; sms_first_line: string | null; message: string | null; amount: number | null; sms_category: string | null; matched: boolean | null; match_status: string | null; balance_after: number | null; device_name: string | null; received_at: string | null }
interface WalletTxn { ontarget_ref: string; status: string | null; amount: number | null; sender_name: string | null; master_merchant: string | null; first_seen_at: string | null }
interface WalletDetail { wallet: string; sms: WalletSms[]; transactions: WalletTxn[] }

export default function WalletReport() {
  const { t } = useLocale()
  const [rows, setRows] = useState<WalletRow[] | null>(null)
  const [days, setDays] = useState(30)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [query, setQuery] = useState('')
  const [activities, setActivities] = useState<string[]>([])
  const [sort, setSort] = useState('sms')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [detail, setDetail] = useState<WalletDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)

  const openDetail = async (wallet: string) => {
    setDetailBusy(true); setDetail(null)
    try { setDetail(await api<WalletDetail>(`/api/wallet-report/${encodeURIComponent(wallet)}`)) }
    catch { setErr(t('تعذّر تحميل تفاصيل المحفظة.', 'Failed to load wallet details.')) }
    finally { setDetailBusy(false) }
  }
  const stCls = (s: string | null) => s === 'PAID' || s === 'APPROVED' ? 'st-paid' : s === 'DECLINED' ? 'st-declined' : s === 'PENDING' ? 'st-pending' : 'st-dim'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const search = new URLSearchParams({ days: String(days) })
      if (from) search.set('from', from)
      if (to) search.set('to', to)
      const next = (await api<{ rows: WalletRow[] }>(`/api/wallet-report?${search}`)).rows
      setRows((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
      setErr(null)
    }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض تقرير المحافظ.', 'You do not have permission to view the wallet report.') : t('تعذّر تحميل التقرير.', 'Failed to load the report.')) }
    finally { setLoading(false) }
  }, [days, from, to, t])
  useEffect(() => { void load() }, [load])

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = (rows ?? []).filter((row) => {
      if (needle && ![row.wallet, row.device, row.merchant].some((value) => String(value ?? '').toLowerCase().includes(needle))) return false
      if (activities.length > 0) {
        const matches = activities.some((activity) =>
          (activity === 'unconfirmed' && row.unconfirmed > 0)
          || (activity === 'withdrawals' && row.withdrawals_count > 0)
          || (activity === 'deposits' && row.deposits_count > 0)
          || (activity === 'balance' && row.balance != null),
        )
        if (!matches) return false
      }
      return true
    })
    return list.sort((a, b) => sort === 'balance' ? Number(b.balance ?? 0) - Number(a.balance ?? 0) : sort === 'withdrawals' ? Number(b.withdrawals_amount ?? 0) - Number(a.withdrawals_amount ?? 0) : sort === 'unconfirmed' ? b.unconfirmed - a.unconfirmed : b.sms_count - a.sms_count)
  }, [rows, query, activities, sort])

  const totals = filteredRows.reduce((a, r) => ({
    wallets: a.wallets + 1,
    sms: a.sms + r.sms_count,
    deposits: a.deposits + (r.deposits_amount ?? 0),
    withdrawals: a.withdrawals + (r.withdrawals_amount ?? 0),
    unconfirmed: a.unconfirmed + r.unconfirmed,
    balance: a.balance + (r.balance ?? 0),
  }), { wallets: 0, sms: 0, deposits: 0, withdrawals: 0, unconfirmed: 0, balance: 0 })
  const timeline = detail ? [...detail.transactions.map((tx) => ({ kind: 'TRX', at: tx.first_seen_at, label: tx.status ?? 'Transaction', amount: tx.amount })), ...detail.sms.map((sms) => ({ kind: 'SMS', at: sms.received_at, label: sms.sms_category === 'withdrawal' ? 'Withdrawal SMS' : 'Deposit SMS', amount: sms.amount }))].filter((item) => item.at).sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at))).slice(0, 20) : []

  return <PanelShell>
    <section className="page-head">
      <h2>📊 {t('تقرير المحافظ (SMS)', 'Wallet SMS report')}</h2>
      <p className="page-sub">{t('كل SMS ومبلغ ورصيد وفرق لكل محفظة مستقبِلة.', 'Every SMS, amount, balance and difference per receiving wallet.')}</p>
    </section>

    <div className="kpi-grid">
      <div className="kpi-card"><div className="kpi-value">{rows ? totals.wallets : '…'}</div><div className="kpi-label">{t('المحافظ', 'Wallets')}</div>{rows && filteredRows.length !== rows.length && <div className="cell-sub">{t('من','of')} {rows.length}</div>}</div>
      <div className="kpi-card"><div className="kpi-value">{rows ? totals.sms.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('رسائل SMS', 'SMS received')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? money(totals.deposits, 'EGP') : '…'}</div><div className="kpi-label">{t('إيداعات', 'Deposits')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? money(totals.withdrawals, 'EGP') : '…'}</div><div className="kpi-label">{t('سحوبات', 'Withdrawals')}</div></div>
      <div className="kpi-card stat-pending"><div className="kpi-value">{rows ? totals.unconfirmed.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('غير مؤكدة', 'Unconfirmed')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? money(totals.balance, 'EGP') : '…'}</div><div className="kpi-label">{t('إجمالي الرصيد', 'Total balance')}</div></div>
    </div>

    <div className="filter-bar transaction-filter-toolbar wallet-report-filter-bar">
      <div className="filter-pills">
        {[7, 30, 90].map((d) => <button key={d} className={`pill${days === d && !from && !to ? ' active' : ''}`} onClick={() => { setDays(d); setFrom(''); setTo('') }}>{t('آخر', 'Last')} {d} {t('يوم', 'days')}</button>)}
      </div>
      <input className="login-input" type="date" value={from} onChange={(e)=>setFrom(e.target.value)} aria-label={t('من','From')}/>
      <input className="login-input" type="date" value={to} onChange={(e)=>setTo(e.target.value)} aria-label={t('إلى','To')}/>
      <label className="wallet-report-search"><Search size={15}/><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder={t('بحث: محفظة / جهاز / تاجر…','Search wallet / device / merchant…')}/></label>
      <MultiSelectFilter label={t('نوع النشاط','Activity type')} allLabel={t('كل النشاط','All activity')} options={[{value:'unconfirmed',label:t('غير مؤكدة','Unconfirmed')},{value:'withdrawals',label:t('لديها سحوبات','Has withdrawals')},{value:'deposits',label:t('لديها إيداعات','Has deposits')},{value:'balance',label:t('لديها رصيد','Has balance')}]} value={activities} onChange={setActivities}/>
      <select className="login-input" value={sort} onChange={(e)=>setSort(e.target.value)} aria-label={t('ترتيب','Sort')}><option value="sms">{t('الأكثر SMS','Most SMS')}</option><option value="balance">{t('الأعلى رصيداً','Highest balance')}</option><option value="withdrawals">{t('الأكثر سحباً','Most withdrawals')}</option><option value="unconfirmed">{t('الأكثر غير مؤكد','Most unconfirmed')}</option></select>
      <span className="automation-filter-count">{filteredRows.length} / {rows?.length ?? 0}</span>
      <button className="btn-ghost btn-sm" disabled={loading} onClick={()=>void load()}><RefreshCw size={14} className={loading?'spin':''}/> {t('تحديث','Refresh')}</button>
      <button className="btn-ghost btn-sm" onClick={()=>{setQuery('');setActivities([]);setSort('sms');setDays(30);setFrom('');setTo('')}}><RotateCcw size={14}/> {t('إعادة ضبط','Reset')}</button>
    </div>

    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {!rows && !err && <p className="sidebar-hint">{t('جارٍ الحساب…', 'Calculating…')}</p>}
      {rows && filteredRows.length === 0 && <p>{t('لا توجد بيانات مطابقة.', 'No matching wallet data.')}</p>}
      {filteredRows.length > 0 && <div className="table-wrap"><table className="data-table">
        <thead><tr>
          <th>{t('المحفظة', 'Wallet')}</th><th>{t('الجهاز / التاجر', 'Device / merchant')}</th>
          <th>SMS</th><th>{t('مبلغ SMS', 'SMS amount')}</th>
          <th>{t('إيداعات', 'Deposits')}</th><th>{t('سحوبات', 'Withdrawals')}</th>
          <th>{t('غير مؤكدة', 'Unconfirmed')}</th><th>{t('الوارد', 'Received')}</th><th>{t('الصادر', 'Sent')}</th><th>{t('الرصيد الحالي', 'Current balance')}</th><th>{t('استخدام الحد', 'Limit used')}</th><th>{t('المتاح حتى الحد', 'Remaining capacity')}</th><th>{t('الاستفادة', 'Utilization')}</th><th>{t('ربح اليوم', "Today's profit")}</th><th>{t('متوسط الإيداع', 'Avg deposit')}</th><th>{t('متوسط السحب', 'Avg withdrawal')}</th>
          <th title={t('فرق نشاط SMS عن تغيّر الرصيد — غالباً تحويلات للخزينة', 'SMS activity vs balance change — usually treasury sweeps')}>{t('فرق الرصيد', 'Balance diff')}</th><th /></tr></thead>
        <tbody>{filteredRows.map((r) => (
          <tr key={r.wallet} className="clickable-row" onClick={() => void openDetail(r.wallet)}>
            <td className="mono">{r.wallet}</td>
            <td>{r.device ?? '—'}{r.merchant && <div className="cell-sub">{r.merchant}</div>}</td>
            <td className="mono">{r.sms_count}</td>
            <td className="mono">{money(r.sms_amount, 'EGP')}</td>
            <td className="mono">{r.deposits_count}<div className="cell-sub mono">{money(r.deposits_amount, 'EGP')}</div></td>
            <td className="mono">{r.withdrawals_count}{r.withdrawals_count > 0 && <div className="cell-sub mono">{money(r.withdrawals_amount, 'EGP')}</div>}</td>
            <td>{r.unconfirmed > 0 ? <span className="pay-status-badge st-pending">{r.unconfirmed}</span> : <span className="mono">0</span>}</td>
            <td className="mono positive-text">{money(r.received ?? r.deposits_amount, 'EGP')}</td>
            <td className="mono negative-text">{money(r.sent ?? r.withdrawals_amount, 'EGP')}</td>
            <td className="mono">{money(r.balance, 'EGP')}<div className="cell-sub">SMS: {money(r.sms_balance, 'EGP')}</div></td>
            <td className="mono"><div>{money(r.daily_used ?? 0, 'EGP')} / {money(r.daily_limit ?? 60000, 'EGP')}</div><div className="cell-sub">M: {money(r.monthly_used ?? 0, 'EGP')} / {money(r.monthly_limit ?? 200000, 'EGP')}</div></td>
            <td className={`mono wallet-remaining${r.limit_warning ? ` ${r.limit_warning}` : ''}`}><div>D: {money(r.daily_remaining ?? Math.max(0, (r.daily_limit ?? 60000) - (r.daily_used ?? 0)), 'EGP')}</div><div className="cell-sub">M: {money(r.monthly_remaining ?? Math.max(0, (r.monthly_limit ?? 200000) - (r.monthly_used ?? 0)), 'EGP')}</div></td>
            <td><div className={`wallet-limit-meter${r.limit_warning ? ` ${r.limit_warning}` : ''}`}><i style={{ width: `${Math.min(100, r.utilization_pct ?? 0)}%` }} /></div><span className={`cell-sub${r.limit_warning ? ' wallet-limit-warning' : ''}`}>{(r.utilization_pct ?? 0).toFixed(1)}%{r.limit_warning === 'limit_reached' ? ' · LIMIT' : r.limit_warning === 'limit_soon' ? ' · SOON' : ''}</span></td>
            <td className="mono positive-text">{money(r.today_profit ?? 0, 'EGP')}</td>
            <td className="mono">{money(r.avg_deposit ?? 0, 'EGP')}</td>
            <td className="mono">{money(r.avg_withdrawal ?? 0, 'EGP')}</td>
            <td className="mono" style={balanceDiff(r) != null && balanceDiff(r) !== 0 ? { color: 'var(--status-declined)' } : undefined}>{balanceDiff(r) != null ? money(balanceDiff(r), 'EGP') : '—'}</td>
            <td onClick={(e) => e.stopPropagation()}><Link className="btn-ghost btn-sm" to={`/sms?q=${encodeURIComponent(r.wallet)}`}>{t('👁 الرسائل', '👁 Messages')}</Link></td>
          </tr>
        ))}</tbody>
      </table></div>}
    </section>

    {(detail || detailBusy) && (
      <div className="drawer-backdrop" onClick={() => setDetail(null)}>
        <aside className="drawer wallet-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h3 className="mono">{detailBusy ? t('جارٍ التحميل…', 'Loading…') : `📱 ${detail?.wallet}`}</h3>
            <button className="btn-ghost btn-sm" onClick={() => setDetail(null)} aria-label={t('إغلاق', 'Close')}>✕</button>
          </div>
          {detail && <>
            <div className="section-label" style={{ marginTop: 0 }}>{t('خط زمني للمحفظة', 'Wallet timeline')} ({timeline.length})</div>
            <div className="wallet-timeline">{timeline.length === 0 ? <p className="sidebar-hint">{t('لا يوجد نشاط زمني.', 'No timeline activity.')}</p> : timeline.map((item, index) => <div className="wallet-timeline-item" key={`${item.kind}-${item.at}-${index}`}><span className={`wallet-timeline-dot ${item.kind === 'SMS' ? 'sms' : 'trx'}`} /><div><strong>{item.kind}</strong> · {item.label}<div className="cell-sub mono">{item.at ? new Date(item.at).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }) : '—'} · {money(item.amount, 'EGP')}</div></div></div>)}</div>
            <div className="section-label" style={{ marginTop: 0 }}>{t('المعاملات على هذه المحفظة', 'Transactions to this wallet')} ({detail.transactions.length})</div>
            {detail.transactions.length === 0 ? <p className="sidebar-hint">{t('لا توجد معاملات مرتبطة.', 'No linked transactions.')}</p> : (
              <div className="table-wrap"><table className="data-table">
                <thead><tr><th>{t('المرجع', 'Ref')}</th><th>{t('الحالة', 'Status')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('المُرسِل', 'Sender')}</th></tr></thead>
                <tbody>{detail.transactions.map((tx) => <tr key={tx.ontarget_ref}><td className="mono"><Link to={`/transactions/${encodeURIComponent(tx.ontarget_ref)}`}>{tx.ontarget_ref}</Link></td><td><span className={`pay-status-badge ${stCls(tx.status)}`}>{tx.status ?? '—'}</span></td><td className="mono">{money(tx.amount, 'EGP')}</td><td>{tx.sender_name ?? '—'}</td></tr>)}</tbody>
              </table></div>
            )}
            <div className="section-label">{t('آخر الرسائل', 'Recent messages')} ({detail.sms.length})</div>
            {detail.sms.length === 0 ? <p className="sidebar-hint">{t('لا توجد رسائل.', 'No messages.')}</p> : (
              <div className="wallet-sms-feed">{detail.sms.map((s) => (
                <div key={s.id} className={`tv-item${s.matched ? ' ok' : ''}`}>
                  <div className="tv-item-head">
                    <span className="mono">{money(s.amount, 'EGP')} · {s.sms_category === 'withdrawal' ? '📤' : '📥'} {s.matched ? '🔗' : ''}</span>
                    <span className="mono dim">{s.received_at ? new Date(s.received_at).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }) : '—'}</span>
                  </div>
                  <div className="cell-sub">{s.sms_first_line ?? (s.message ?? '').slice(0, 90)}</div>
                  {s.balance_after != null && <div className="cell-sub mono">{t('الرصيد بعدها', 'balance after')}: {money(s.balance_after, 'EGP')} · {s.device_name ?? '—'}</div>}
                </div>
              ))}</div>
            )}
          </>}
        </aside>
      </div>
    )}
  </PanelShell>
}
