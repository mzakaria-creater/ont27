import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Tab = 'overview' | 'transactions' | 'wallets' | 'merchants' | 'reports'
interface WindowStats { depositCount: number; depositVolume: number; payoutCount: number; payoutVolume: number; declined: number; attempts: number }
interface ExecutiveData { generatedAt: string; windows: { day: WindowStats; week: WindowStats; month: WindowStats }; queues: { pendingDeposits: number; pendingPayouts: number; smsReview: number }; devices: { total: number; online: number }; topMerchants: { merchant: string; volume: number; count: number }[]; daily: { date: string; incoming: number; outgoing: number }[] }
interface Transaction { tx_id?: number; maven_id?: number; ontarget_ref: string | null; amount: number | null; status: string | null; payment_method?: string | null; pay_by?: string | null; merchant: string | null; sender_name?: string | null; sender_number?: string | null; account_name?: string | null; mobile_no?: string | null; first_seen_at: string | null; kind: 'deposit' | 'payout' }
interface Wallet { to_account_number: string; provider: string | null; device: string | null; sim_slot: number | null; daily_limit: number | null; merchant: string | null }
interface WalletData { wallets: Wallet[]; devices: { device: string; sim_slot: number | null; online: boolean | null; balance: number | null }[] }
interface Reports { totals?: { depCount: number; depVolume: number; declined: number; payCount: number; payVolume: number; commission: number; fees: number }; depositStatuses?: Record<string, { count: number; amount: number }>; payoutStatuses?: Record<string, { count: number; amount: number }>; daily: unknown[]; byMethod: { key?: string; method?: string; master?: string; count: number; volume?: number; amount?: number }[] }

const approved = (status: string | null) => status === 'PAID' || status === 'APPROVED'

export default function AnalyticsDashboard() {
  const { t } = useLocale()
  const [tab, setTab] = useState<Tab>('overview')
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day')
  const [executive, setExecutive] = useState<ExecutiveData | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [wallets, setWallets] = useState<WalletData | null>(null)
  const [reports, setReports] = useState<Reports | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const [exec, tx, wallet, report] = await Promise.all([
        api<ExecutiveData>('/api/executive-dashboard'),
        api<{ rows: Transaction[] }>('/api/transactions?limit=25'),
        api<WalletData>('/api/wallets'),
        api<Reports>('/api/reports'),
      ])
      setExecutive(exec); setTransactions(tx.rows); setWallets(wallet); setReports(report); setError(false)
    } catch { setError(true) } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(id) }, [load])
  const stats = executive?.windows[period]
  const rate = stats?.attempts ? (stats.depositCount / stats.attempts) * 100 : 0
  const net = (stats?.depositVolume ?? 0) - (stats?.payoutVolume ?? 0)
  const walletUtilization = wallets?.devices.length ? (wallets.devices.filter((row) => row.online).length * 100) / wallets.devices.length : null
  const pendingReview = (executive?.queues.pendingDeposits ?? 0) + (executive?.queues.pendingPayouts ?? 0) + (executive?.queues.smsReview ?? 0)
  // `/api/reports` now serves the comprehensive-report shape. Keep the
  // dashboard tolerant of both shapes during rolling deployments so a newer
  // API can never crash an older dashboard bundle (or vice versa).
  const reportTotals = useMemo(() => {
    if (reports?.totals) return reports.totals
    const deposits = Object.entries(reports?.depositStatuses ?? {})
    const payouts = Object.entries(reports?.payoutStatuses ?? {})
    const approvedDeposit = deposits.filter(([status]) => status === 'PAID' || status === 'APPROVED')
    const approvedPayout = payouts.filter(([status]) => status === 'PAID' || status === 'APPROVED')
    return {
      depCount: approvedDeposit.reduce((sum, [, row]) => sum + row.count, 0), depVolume: approvedDeposit.reduce((sum, [, row]) => sum + row.amount, 0),
      declined: reports?.depositStatuses?.DECLINED?.count ?? 0,
      payCount: approvedPayout.reduce((sum, [, row]) => sum + row.count, 0), payVolume: approvedPayout.reduce((sum, [, row]) => sum + row.amount, 0),
      commission: 0, fees: 0,
    }
  }, [reports])
  const maxDaily = useMemo(() => Math.max(1, ...(executive?.daily ?? []).map((row) => Math.max(row.incoming, row.outgoing))), [executive])
  const tabs: { id: Tab; ar: string; en: string }[] = [
    { id: 'overview', ar: 'نظرة عامة', en: 'Overview' }, { id: 'transactions', ar: 'المعاملات', en: 'Transactions' }, { id: 'wallets', ar: 'المحافظ', en: 'Wallets' }, { id: 'merchants', ar: 'التجار', en: 'Merchants' }, { id: 'reports', ar: 'التقارير', en: 'Reports' },
  ]

  return <PanelShell>
    <section className="page-head">
      <h2>{t('لوحة التحليلات المباشرة', 'Live Analytics Dashboard')}</h2>
      <p className="page-sub">{t('عرض تشغيلي موحّد للإيداعات، المحافظ، التجار والتقارير من البيانات الحية.', 'A unified operations view of deposits, wallets, merchants, and reports from live data.')}{executive && <> · {t('تحديث', 'Updated')} {new Date(executive.generatedAt).toLocaleTimeString()}</>}</p>
      <div className="filter-bar">
        {tabs.map((item) => <button key={item.id} className={tab === item.id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setTab(item.id)}>{t(item.ar, item.en)}</button>)}
        <button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button>
      </div>
    </section>
    {error && <div className="card warn">{t('تعذّر تحميل بعض البيانات الحية.', 'Unable to load some live data.')}</div>}

    {tab === 'overview' && <>
      <div className="filter-bar">{(['day', 'week', 'month'] as const).map((key) => <button key={key} className={period === key ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setPeriod(key)}>{key === 'day' ? t('24 ساعة', '24 hours') : key === 'week' ? t('7 أيام', '7 days') : t('30 يوماً', '30 days')}</button>)}</div>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-value">{money(reportTotals.depVolume + reportTotals.payVolume, 'EGP')}</div><div className="kpi-label">{t('إجمالي الحجم', 'Total volume')}</div><div className="cell-sub">{t('كل البيانات المعتمدة', 'all approved data')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{money(executive?.windows.day.depositVolume ?? 0, 'EGP')}</div><div className="kpi-label">{t('إيداعات اليوم', 'Today deposits')}</div><div className="cell-sub">{executive?.windows.day.depositCount ?? 0} {t('عملية', 'transactions')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{money(executive?.windows.day.payoutVolume ?? 0, 'EGP')}</div><div className="kpi-label">{t('سحوبات اليوم', 'Today payouts')}</div><div className="cell-sub">{executive?.windows.day.payoutCount ?? 0} {t('عملية', 'transactions')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{rate.toFixed(1)}%</div><div className="kpi-label">{t('نسبة القبول', 'Approval rate')}</div><div className="cell-sub">{t('للفترة المختارة', 'selected period')}</div></div>
        <Link to="/approvals" className="kpi-card"><div className="kpi-value">{pendingReview}</div><div className="kpi-label">{t('قيد المراجعة', 'Pending review')}</div><div className="cell-sub">{executive?.queues.smsReview ?? 0} SMS</div></Link>
        <div className="kpi-card"><div className="kpi-value">{stats?.declined ?? 0}</div><div className="kpi-label">{t('معاملات فاشلة', 'Failed transactions')}</div><div className="cell-sub">{t('مرفوضة في الفترة', 'declined in period')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{money(net, 'EGP')}</div><div className="kpi-label">{t('صافي المركز النقدي', 'Net cash position')}</div><div className="cell-sub">{t('وارد ناقص صادر', 'incoming less outgoing')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{walletUtilization == null ? '—' : `${walletUtilization.toFixed(0)}%`}</div><div className="kpi-label">{t('استخدام المحافظ', 'Wallet utilization')}</div><div className="cell-sub">{t('نسبة الأجهزة المتصلة', 'online device coverage')}</div></div>
        <div className="kpi-card"><div className="kpi-value">—</div><div className="kpi-label">{t('تسويات مستحقة', 'Settlement due')}</div><div className="cell-sub">{t('غير منشور: صافي الرسوم غير محسوم', 'not published: net fee basis unresolved')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{money(reportTotals.commission + reportTotals.fees, 'EGP')}</div><div className="kpi-label">{t('إيراد الرسوم', 'Revenue from fees')}</div><div className="cell-sub">{t('القيم المسجلة فقط', 'recorded values only')}</div></div>
      </div>
      <div className="responsive-content-grid executive-content-grid">
        <section className="card recent-card"><div className="recent-head"><h3>{t('التدفق اليومي', 'Daily cash flow')}</h3><span className="cell-sub">{t('آخر 14 يوماً', 'Last 14 days')}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('التاريخ', 'Date')}</th><th>{t('وارد', 'Incoming')}</th><th>{t('صادر', 'Outgoing')}</th><th>{t('الصافي', 'Net')}</th></tr></thead><tbody>{(executive?.daily ?? []).slice(0, 14).map((row) => <tr key={row.date}><td className="mono">{row.date}</td><td className="mono">{money(row.incoming, 'EGP')}<div className="analytics-bar"><i style={{ width: `${(row.incoming / maxDaily) * 100}%` }} /></div></td><td className="mono">{money(row.outgoing, 'EGP')}<div className="analytics-bar analytics-bar-out"><i style={{ width: `${(row.outgoing / maxDaily) * 100}%` }} /></div></td><td className="mono">{money(row.incoming - row.outgoing, 'EGP')}</td></tr>)}</tbody></table></div></section>
        <section className="card recent-card"><div className="recent-head"><h3>{t('أحدث المعاملات', 'Latest transactions')}</h3><Link className="pay-status-link" to="/transactions">{t('الكل', 'All')} ←</Link></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المرجع', 'Reference')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الحالة', 'Status')}</th></tr></thead><tbody>{transactions.slice(0, 8).map((row) => <tr key={`${row.kind}-${row.tx_id ?? row.maven_id}`}><td className="mono">{row.ontarget_ref ?? '—'}</td><td className="mono">{money(row.amount, 'EGP')}</td><td><span className={`pay-status-badge ${approved(row.status) ? 'st-paid' : 'st-dim'}`}>{row.status ?? '—'}</span></td></tr>)}</tbody></table></div></section>
      </div>
      <div className="responsive-content-grid executive-content-grid">
        <section className="card recent-card"><div className="recent-head"><h3>{t('توزيع طرق الدفع', 'Payment method split')}</h3></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الطريقة', 'Method')}</th><th>{t('الحجم', 'Volume')}</th><th>{t('العمليات', 'Count')}</th></tr></thead><tbody>{(reports?.byMethod ?? []).slice(0, 8).map((row, index) => { const label = row.method ?? row.key?.split('||')[0] ?? '—'; return <tr key={`${label}-${row.master ?? index}`}><td>{label}</td><td className="mono">{money(row.amount ?? row.volume ?? 0, 'EGP')}</td><td className="mono">{row.count}</td></tr> })}</tbody></table></div></section>
        <section className="card recent-card"><div className="recent-head"><h3>{t('توزيع الحالات', 'Status distribution')}</h3></div><div className="source-list"><div><span>{t('معتمدة', 'Approved')}</span><b>{stats?.depositCount ?? 0}</b></div><div><span>{t('مرفوضة', 'Declined')}</span><b>{stats?.declined ?? 0}</b></div><div><span>{t('قيد المراجعة', 'Pending review')}</span><b>{pendingReview}</b></div></div></section>
      </div>
    </>}

    {tab === 'transactions' && <section className="card recent-card"><div className="recent-head"><h3>{t('المعاملات الحية', 'Live transactions')}</h3><span className="cell-sub">{loading ? t('جارٍ التحميل…', 'Loading…') : transactions.length}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('النوع', 'Type')}</th><th>{t('المرجع', 'Reference')}</th><th>{t('التاجر / الطرف', 'Merchant / party')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الوقت', 'Time')}</th></tr></thead><tbody>{transactions.map((row) => <tr key={`${row.kind}-${row.tx_id ?? row.maven_id}`}><td>{row.kind === 'deposit' ? t('إيداع', 'Deposit') : t('سحب', 'Payout')}</td><td className="mono">{row.ontarget_ref ?? '—'}</td><td>{row.merchant ?? row.sender_name ?? row.sender_number ?? row.account_name ?? row.mobile_no ?? '—'}</td><td className="mono">{money(row.amount, 'EGP')}</td><td>{row.payment_method ?? row.pay_by ?? '—'}</td><td><span className={`pay-status-badge ${approved(row.status) ? 'st-paid' : 'st-dim'}`}>{row.status ?? '—'}</span></td><td className="mono">{row.first_seen_at ? new Date(row.first_seen_at).toLocaleString() : '—'}</td></tr>)}</tbody></table></div></section>}

    {tab === 'wallets' && <section className="card recent-card"><div className="recent-head"><h3>{t('صحة المحافظ', 'Wallet health')}</h3><Link className="pay-status-link" to="/wallets">{t('إدارة المحافظ', 'Manage wallets')} ←</Link></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المحفظة', 'Wallet')}</th><th>{t('المزود', 'Provider')}</th><th>{t('الجهاز', 'Device')}</th><th>{t('الرصيد', 'Balance')}</th><th>{t('الحد اليومي', 'Daily limit')}</th><th>{t('الحالة', 'Status')}</th></tr></thead><tbody>{(wallets?.wallets ?? []).map((wallet) => { const device = wallets?.devices.find((row) => row.device === wallet.device && row.sim_slot === wallet.sim_slot); return <tr key={wallet.to_account_number}><td className="mono">{wallet.to_account_number}</td><td>{wallet.provider ?? '—'}</td><td>{wallet.device ?? '—'}</td><td className="mono">{device?.balance == null ? '—' : money(device.balance, 'EGP')}</td><td className="mono">{wallet.daily_limit == null ? '—' : money(wallet.daily_limit, 'EGP')}</td><td><span className={`pay-status-badge ${device?.online ? 'st-paid' : 'st-dim'}`}>{device?.online ? t('متصل', 'Online') : t('غير متصل', 'Offline')}</span></td></tr> })}</tbody></table></div></section>}

    {tab === 'merchants' && <section className="card recent-card"><div className="recent-head"><h3>{t('أهم التجار حسب الإيداعات المعتمدة', 'Top merchants by approved deposits')}</h3><Link className="pay-status-link" to="/reports">{t('التقارير', 'Reports')} ←</Link></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('التاجر', 'Merchant')}</th><th>{t('الحجم', 'Volume')}</th><th>{t('العمليات', 'Transactions')}</th></tr></thead><tbody>{(executive?.topMerchants ?? []).map((merchant) => <tr key={merchant.merchant}><td>{merchant.merchant}</td><td className="mono">{money(merchant.volume, 'EGP')}</td><td className="mono">{merchant.count}</td></tr>)}</tbody></table></div></section>}

    {tab === 'reports' && <section className="card recent-card"><div className="recent-head"><h3>{t('ملخص التقارير لكل البيانات', 'All-time report summary')}</h3><Link className="pay-status-link" to="/reports">{t('فتح التقارير التفصيلية', 'Open detailed reports')} ←</Link></div><div className="kpi-grid"><div className="kpi-card"><div className="kpi-value">{money(reportTotals.depVolume, 'EGP')}</div><div className="kpi-label">{t('إيداعات معتمدة', 'Approved deposits')}</div></div><div className="kpi-card"><div className="kpi-value">{money(reportTotals.payVolume, 'EGP')}</div><div className="kpi-label">{t('سحوبات معتمدة', 'Approved payouts')}</div></div><div className="kpi-card"><div className="kpi-value">{reportTotals.depCount}</div><div className="kpi-label">{t('عمليات إيداع', 'Deposit transactions')}</div></div><div className="kpi-card"><div className="kpi-value">{reportTotals.declined}</div><div className="kpi-label">{t('إيداعات مرفوضة', 'Declined deposits')}</div></div></div></section>}
  </PanelShell>
}
