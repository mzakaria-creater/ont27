import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Activity, ArrowDownToLine, ArrowUpFromLine, CalendarDays, CircleDollarSign, Clock3, Filter, Landmark, RefreshCw, RotateCcw, Table2, TrendingUp, UsersRound, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Preset = 'today' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'custom'
interface Summary { depositCount: number; depositVolume: number; payoutCount: number; payoutVolume: number; declined: number; pending: number; attempts: number; fees: number }
interface PivotRow { merchant: string; method: string; paidCount: number; paidVolume: number; pendingCount: number; pendingVolume: number; declinedCount: number; declinedVolume: number; totalCount: number; totalVolume: number }
interface ExecutiveData {
  generatedAt: string
  range: { from: string; to: string }
  summary: Summary
  options: { merchants: string[]; methods: string[]; statuses: string[] }
  queues: { pendingDeposits: number; pendingPayouts: number; smsReview: number }
  devices: { total: number; online: number }
  pivot: PivotRow[]
  daily: { date: string; incoming: number; outgoing: number }[]
}

const iso = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const rangeFor = (preset: Exclude<Preset, 'custom'>) => {
  const now = new Date()
  const start = new Date(now)
  const end = new Date(now)
  if (preset === 'this_week' || preset === 'last_week') {
    const mondayOffset = (now.getDay() + 6) % 7
    start.setDate(now.getDate() - mondayOffset - (preset === 'last_week' ? 7 : 0))
    end.setDate(start.getDate() + (preset === 'last_week' ? 6 : mondayOffset))
  } else if (preset === 'this_month') start.setDate(1)
  else if (preset === 'last_month') { start.setMonth(now.getMonth() - 1, 1); end.setDate(0) }
  return { from: iso(start), to: iso(end) }
}

export default function ExecutiveDashboard() {
  const { t } = useLocale()
  const [search, setSearch] = useSearchParams()
  const initialPreset = (search.get('preset') as Preset) || 'this_month'
  const initialRange = initialPreset === 'custom'
    ? { from: search.get('from') || iso(new Date()), to: search.get('to') || iso(new Date()) }
    : rangeFor(initialPreset)
  const [preset, setPreset] = useState<Preset>(initialPreset)
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [merchant, setMerchant] = useState(search.get('merchant') || '')
  const [method, setMethod] = useState(search.get('method') || '')
  const [status, setStatus] = useState(search.get('status') || '')
  const [applied, setApplied] = useState({ from: initialRange.from, to: initialRange.to, merchant, method, status })
  const [data, setData] = useState<ExecutiveData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ from: applied.from, to: applied.to })
      if (applied.merchant) query.set('merchant', applied.merchant)
      if (applied.method) query.set('method', applied.method)
      if (applied.status) query.set('status', applied.status)
      setData(await api<ExecutiveData>(`/api/executive-dashboard?${query}`))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية عرض لوحة الإدارة التنفيذية.', 'You do not have permission to view the Executive Dashboard.')
        : t('تعذّر تحميل بيانات لوحة الإدارة التنفيذية.', 'Unable to load Executive Dashboard data.'))
    } finally { setLoading(false) }
  }, [applied, t])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(interval)
  }, [load])

  const choosePreset = (value: Exclude<Preset, 'custom'>) => {
    const range = rangeFor(value)
    setPreset(value); setFrom(range.from); setTo(range.to)
    setApplied({ ...applied, ...range })
    setSearch({ preset: value, ...range, ...(merchant && { merchant }), ...(method && { method }), ...(status && { status }) })
  }
  const applyFilters = () => {
    if (!from || !to || from > to) { setError(t('نطاق التاريخ غير صحيح.', 'Invalid date range.')); return }
    setApplied({ from, to, merchant, method, status })
    setSearch({ preset, from, to, ...(merchant && { merchant }), ...(method && { method }), ...(status && { status }) })
  }
  const resetFilters = () => {
    const range = rangeFor('this_month')
    setPreset('this_month'); setFrom(range.from); setTo(range.to); setMerchant(''); setMethod(''); setStatus('')
    setApplied({ ...range, merchant: '', method: '', status: '' })
    setSearch({ preset: 'this_month', ...range })
  }

  const stats = data?.summary
  const approvalRate = stats?.attempts ? (stats.depositCount / stats.attempts) * 100 : 0
  const net = (stats?.depositVolume ?? 0) - (stats?.payoutVolume ?? 0)
  const totalVolume = (stats?.depositVolume ?? 0) + (stats?.payoutVolume ?? 0)
  const averageDeposit = stats?.depositCount ? stats.depositVolume / stats.depositCount : 0
  const days = Math.max(1, Math.round((new Date(applied.to).getTime() - new Date(applied.from).getTime()) / 86_400_000) + 1)
  const maxFlow = useMemo(() => Math.max(1, ...(data?.daily ?? []).map((row) => Math.max(row.incoming, row.outgoing))), [data])
  const activeFilters = [merchant, method, status].filter(Boolean).length
  const presets: { id: Exclude<Preset, 'custom'>; ar: string; en: string }[] = [
    { id: 'today', ar: 'اليوم', en: 'Today' }, { id: 'this_week', ar: 'هذا الأسبوع', en: 'This week' },
    { id: 'last_week', ar: 'الأسبوع الماضي', en: 'Last week' }, { id: 'this_month', ar: 'هذا الشهر', en: 'This month' },
    { id: 'last_month', ar: 'الشهر الماضي', en: 'Last month' },
  ]
  const kpis = [
    { icon: CircleDollarSign, label: t('إجمالي الحجم', 'Total volume'), value: money(totalVolume, 'EGP'), sub: `${stats?.depositCount ?? 0} + ${stats?.payoutCount ?? 0} ${t('عملية معتمدة', 'approved transactions')}` },
    { icon: ArrowDownToLine, label: t('الإيداعات المعتمدة', 'Approved deposits'), value: money(stats?.depositVolume ?? 0, 'EGP'), sub: `${stats?.depositCount ?? 0} ${t('عملية', 'transactions')}` },
    { icon: ArrowUpFromLine, label: t('السحوبات المعتمدة', 'Approved payouts'), value: money(stats?.payoutVolume ?? 0, 'EGP'), sub: `${stats?.payoutCount ?? 0} ${t('عملية', 'transactions')}` },
    { icon: Landmark, label: t('صافي التدفق', 'Net cash flow'), value: money(net, 'EGP'), sub: net >= 0 ? t('موجب', 'Positive') : t('سالب', 'Negative') },
    { icon: TrendingUp, label: t('نسبة القبول', 'Approval rate'), value: `${approvalRate.toFixed(1)}%`, sub: `${stats?.declined ?? 0} ${t('مرفوض', 'declined')}` },
    { icon: Clock3, label: t('قيد الانتظار بالنطاق', 'Pending in range'), value: String(stats?.pending ?? 0), sub: t('إيداعات تنتظر القرار', 'Deposits awaiting decision') },
    { icon: WalletCards, label: t('متوسط الإيداع', 'Average deposit'), value: money(averageDeposit, 'EGP'), sub: t('للمعاملات المعتمدة', 'Approved transactions') },
    { icon: Activity, label: t('متوسط الحجم اليومي', 'Average daily volume'), value: money(totalVolume / days, 'EGP'), sub: `${days} ${t('يوم', 'days')}` },
    { icon: CircleDollarSign, label: t('رسوم وعمولات', 'Fees & commission'), value: money(stats?.fees ?? 0, 'EGP'), sub: t('حسب البيانات المسجلة', 'From recorded fields') },
    { icon: UsersRound, label: t('التجار النشطون', 'Active merchants'), value: String(new Set((data?.pivot ?? []).map((row) => row.merchant)).size), sub: t('ضمن النطاق والفلاتر', 'Within range and filters') },
    { icon: Activity, label: t('صحة الأجهزة', 'Device health'), value: data ? `${data.devices.online}/${data.devices.total}` : '…', sub: t('متصل الآن', 'Online now') },
    { icon: Clock3, label: t('قائمة المراجعة', 'Review queue'), value: String((data?.queues.pendingDeposits ?? 0) + (data?.queues.pendingPayouts ?? 0) + (data?.queues.smsReview ?? 0)), sub: t('إيداع + سحب + SMS', 'Deposits + payouts + SMS') },
  ]

  return <PanelShell>
    <section className="page-head executive-page-head">
      <div><h2>{t('لوحة الإدارة التنفيذية', 'Executive Dashboard')}</h2><p className="page-sub">{t('تحليل موحّد للسيولة والأداء حسب نطاق زمني تقويمي.', 'Unified liquidity and performance analysis by calendar date range.')}{data && <> · {t('آخر تحديث', 'Updated')} {new Date(data.generatedAt).toLocaleTimeString()}</>}</p></div>
      <button className="btn-ghost btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={14} aria-hidden="true" className={loading ? 'spin' : ''} />{t('تحديث', 'Refresh')}</button>
    </section>

    <section className="card executive-filter-card">
      <div className="executive-presets" aria-label={t('نطاقات سريعة', 'Quick date ranges')}>{presets.map((item) => <button key={item.id} type="button" className={preset === item.id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => choosePreset(item.id)}>{t(item.ar, item.en)}</button>)}</div>
      <div className="executive-filter-grid">
        <label><span>{t('من', 'From')}</span><input className="login-input" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPreset('custom') }} /></label>
        <label><span>{t('إلى', 'To')}</span><input className="login-input" type="date" value={to} onChange={(event) => { setTo(event.target.value); setPreset('custom') }} /></label>
        <label><span>{t('التاجر', 'Merchant')}</span><select className="login-input" value={merchant} onChange={(event) => setMerchant(event.target.value)}><option value="">{t('كل التجار', 'All merchants')}</option>{data?.options.merchants.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{t('طريقة الدفع', 'Payment method')}</span><select className="login-input" value={method} onChange={(event) => setMethod(event.target.value)}><option value="">{t('كل الطرق', 'All methods')}</option>{data?.options.methods.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>{t('الحالة', 'Status')}</span><select className="login-input" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t('كل الحالات', 'All statuses')}</option>{data?.options.statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
        <button className="btn-primary executive-apply" onClick={applyFilters}><Filter size={15} aria-hidden="true" />{t('تطبيق الفلاتر', 'Apply filters')}{activeFilters > 0 && <b>{activeFilters}</b>}</button>
        <button className="btn-ghost executive-reset" onClick={resetFilters}><RotateCcw size={15} aria-hidden="true" />{t('إعادة ضبط', 'Reset')}</button>
      </div>
      <div className="executive-range-summary"><CalendarDays size={14} aria-hidden="true" /><strong>{applied.from}</strong><span>→</span><strong>{applied.to}</strong><span>· {days} {t('يوم', 'days')}</span></div>
    </section>

    {error && <div className="card warn" role="alert">{error}</div>}
    <div className="executive-kpi-grid" aria-live="polite">{kpis.map(({ icon: Icon, label, value, sub }) => <div className="executive-kpi" key={label}><div className="executive-kpi-icon"><Icon size={17} aria-hidden="true" /></div><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>)}</div>

    <div className="responsive-content-grid executive-content-grid">
      <section className="card recent-card"><div className="recent-head"><h3>{t('اتجاه التدفق النقدي', 'Cash-flow trend')}</h3><span className="cell-sub">{applied.from} → {applied.to}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('التاريخ', 'Date')}</th><th>{t('وارد', 'Incoming')}</th><th>{t('صادر', 'Outgoing')}</th><th>{t('الصافي', 'Net')}</th></tr></thead><tbody>{(data?.daily ?? []).map((row) => <tr key={row.date}><td className="mono">{row.date}</td><td><span className="mono">{money(row.incoming, 'EGP')}</span><div className="analytics-bar"><i style={{ width: `${row.incoming / maxFlow * 100}%` }} /></div></td><td><span className="mono">{money(row.outgoing, 'EGP')}</span><div className="analytics-bar analytics-bar-out"><i style={{ width: `${row.outgoing / maxFlow * 100}%` }} /></div></td><td className="mono">{money(row.incoming - row.outgoing, 'EGP')}</td></tr>)}</tbody></table></div></section>
      <section className="card recent-card executive-queue-card"><div className="recent-head"><h3>{t('الحالة التشغيلية', 'Operating status')}</h3><Link className="pay-status-link" to="/approvals">{t('فتح المراجعة', 'Open review')} ←</Link></div><div className="executive-queue-list"><div><span>{t('إيداعات معلقة', 'Pending deposits')}</span><strong>{data?.queues.pendingDeposits ?? '…'}</strong></div><div><span>{t('سحوبات معلقة', 'Pending payouts')}</span><strong>{data?.queues.pendingPayouts ?? '…'}</strong></div><div><span>{t('SMS للمراجعة', 'SMS review')}</span><strong>{data?.queues.smsReview ?? '…'}</strong></div><div><span>{t('أجهزة متصلة', 'Online devices')}</span><strong>{data ? `${data.devices.online}/${data.devices.total}` : '…'}</strong></div></div></section>
    </div>

    <section className="card recent-card executive-pivot"><div className="recent-head"><div><div className="allocation-title"><Table2 size={18} aria-hidden="true" /><h3>{t('الجدول المحوري', 'Pivot table')}</h3></div><span className="cell-sub">{t('التاجر × طريقة الدفع × الحالة — العدد والقيمة', 'Merchant × payment method × status — count and value')}</span></div><span className="cell-sub">{data?.pivot.length ?? 0} {t('صف', 'rows')}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('التاجر', 'Merchant')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('مدفوع', 'Paid')}</th><th>{t('معلق', 'Pending')}</th><th>{t('مرفوض', 'Declined')}</th><th>{t('الإجمالي', 'Total')}</th></tr></thead><tbody>{(data?.pivot ?? []).map((row) => <tr key={`${row.merchant}-${row.method}`}><td><strong>{row.merchant}</strong></td><td>{row.method}</td><td><span className="pivot-count">{row.paidCount}</span><div className="mono pivot-money">{money(row.paidVolume, 'EGP')}</div></td><td><span className="pivot-count pending">{row.pendingCount}</span><div className="mono pivot-money">{money(row.pendingVolume, 'EGP')}</div></td><td><span className="pivot-count declined">{row.declinedCount}</span><div className="mono pivot-money">{money(row.declinedVolume, 'EGP')}</div></td><td><strong className="mono">{money(row.totalVolume, 'EGP')}</strong><div className="cell-sub">{row.totalCount} {t('عملية', 'transactions')}</div></td></tr>)}</tbody></table>{data && data.pivot.length === 0 && <div className="executive-empty">{t('لا توجد بيانات مطابقة للفلاتر.', 'No data matches the selected filters.')}</div>}</div></section>
  </PanelShell>
}
