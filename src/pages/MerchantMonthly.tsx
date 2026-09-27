import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CalendarRange, Clock3, Download, PlusCircle, Printer, RefreshCw } from 'lucide-react'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { exportCsv } from '../lib/exportTable'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

interface MonthlyRow {
  merchant: string
  month: string // YYYY-MM-01
  paid_n: number
  paid_amt: number | string
  declined_n: number
  declined_amt: number | string
  deposit_fee_rate: number | string
  settlement_fee_rate: number | string
  deposit_fee_egp: number | string
  settlement_fee_egp: number | string
  net_egp: number | string
  first_day: string
  last_day: string
  is_current_month: boolean
  partial_month: boolean
  gap_dates: string[]
  undated_n: number
  volume_share_pct?: number | string
  paid_from_balance_egp?: number | string
  held_from_balance_egp?: number | string
  balance_payment_fees_egp?: number | string
  net_after_balance_egp?: number | string
}
interface BalancePayment { id: string; merchant: string; settlement_month: string; amount: number; settlement_date: string | null; proof_url: string | null; proof_file_name: string | null }

const DEFAULT_RATE = 52.6
const DEFAULT_DEPOSIT_FEE_PCT = 5.5
const DEFAULT_SETTLEMENT_FEE_PCT = 6
const BAR_COLORS = ['#f7b84b', '#4b9bf7', '#7fd47f', '#e56b8c', '#b98af7', '#5cd6c0', '#f79a4b', '#8aa6f7']

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function monthKey(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
function monthKeyToFirstDay(key: string): string { return `${key}-01` }
function monthKeyToLastDay(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m, 0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function formatMonthLabel(dateStr: string, locale: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const d = new Date(y, (m ?? 1) - 1, 1)
  return d.toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-US', { month: 'long', year: 'numeric' })
}
function formatDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-GB')
}
// Compress a sorted, already-in-gap date list into human-readable ranges
// for the tooltip, e.g. ["Jul 1 – Jul 5", "Jul 20 – Jul 26"].
function compressDateRanges(dates: string[]): string {
  if (!dates.length) return ''
  const ranges: [string, string][] = []
  let start = dates[0]
  let prev = dates[0]
  for (let i = 1; i < dates.length; i++) {
    const cur = dates[i]
    const diffDays = (new Date(cur).getTime() - new Date(prev).getTime()) / 86_400_000
    if (diffDays > 1) { ranges.push([start, prev]); start = cur }
    prev = cur
  }
  ranges.push([start, prev])
  return ranges.map(([a, b]) => a === b ? formatDay(a) : `${formatDay(a)} – ${formatDay(b)}`).join(', ')
}

export default function MerchantMonthly() {
  const { t, locale } = useLocale()
  const { can } = useAuth()
  const isMobile = useIsMobile()
  const [merchantOptions, setMerchantOptions] = useState<string[]>([])
  const [selectedMerchants, setSelectedMerchants] = useState<string[]>([])
  const [fromMonth, setFromMonth] = useState('2025-01')
  const [toMonth, setToMonth] = useState(() => monthKey(new Date()))
  const [viewMode, setViewMode] = useState<'gross' | 'net'>('gross')
  const [fxRate, setFxRate] = useState(String(DEFAULT_RATE))
  const [rows, setRows] = useState<MonthlyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [paymentBusy, setPaymentBusy] = useState(false)
  const [balancePayments, setBalancePayments] = useState<BalancePayment[]>([])
  const [paymentForm, setPaymentForm] = useState({ merchant: '', settlement_month: monthKey(new Date()), amount: '', usdt_rate: '', payin_fee_percent: '0', payin_fee_fixed: '0', payout_fee_percent: '0', payout_fee_fixed: '0', settlement_date: new Date().toISOString().slice(0, 10), note: '', proof: null as File | null })

  const loadMerchants = useCallback(async () => {
    try {
      const r = await api<{ merchants: string[] }>('/api/reports/merchant-monthly/merchants')
      setMerchantOptions(r.merchants ?? [])
    } catch { /* non-fatal — the multi-select just stays empty */ }
  }, [])
  useEffect(() => { void loadMerchants() }, [loadMerchants])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const currentKey = monthKey(new Date())
      const params = new URLSearchParams()
      if (selectedMerchants.length) params.set('merchants', selectedMerchants.join(','))
      params.set('from', monthKeyToFirstDay(fromMonth))
      params.set('to', toMonth === currentKey ? new Date().toISOString().slice(0, 10) : monthKeyToLastDay(toMonth))
      const r = await api<{ rows: MonthlyRow[] }>(`/api/reports/merchant-monthly?${params.toString()}`)
      setRows(r.rows ?? [])
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض هذا التقرير.', 'You do not have permission to view this report.') : t('تعذّر تحميل التقرير.', 'Failed to load the report.'))
    } finally { setLoading(false) }
  }, [selectedMerchants, fromMonth, toMonth, t])
  useEffect(() => { void load() }, [load])
  const loadPayments = useCallback(async () => {
    try { setBalancePayments((await api<{ payments: BalancePayment[] }>('/api/settlements/payments')).payments ?? []) } catch { setBalancePayments([]) }
  }, [])
  useEffect(() => { void loadPayments() }, [loadPayments])

  const addPayment = async (event: FormEvent) => {
    event.preventDefault()
    if (!paymentForm.merchant || !paymentForm.amount) return
    setPaymentBusy(true); setError(null)
    try {
      let proof: { proof_url?: string; proof_file_name?: string } = {}
      if (paymentForm.proof) {
        const form = new FormData(); form.append('file', paymentForm.proof)
        proof = await api<{ proof_url?: string; proof_file_name?: string }>('/api/settlements/payments/proof', { method: 'POST', body: form })
      }
      const { proof: _file, ...values } = paymentForm
      await api('/api/settlements/payments', { method: 'POST', body: JSON.stringify({ ...values, ...proof, payment_fee: 0, service_fee: 0, blocked_percent: 0 }) })
      setPaymentForm((current) => ({ ...current, amount: '', note: '', proof: null }))
      setShowPaymentForm(false)
      await load()
      await loadPayments()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('تعذّر تسجيل الدفعة من الرصيد.', 'Could not record the balance payment.'))
    } finally { setPaymentBusy(false) }
  }

  const fx = Number(fxRate) > 0 ? Number(fxRate) : DEFAULT_RATE

  // Group in the order rows already arrive (merchant, then month — both
  // ascending from the RPC), so re-grouping here never reorders anything.
  const grouped = useMemo(() => {
    const map = new Map<string, MonthlyRow[]>()
    for (const row of rows) {
      const list = map.get(row.merchant) ?? []
      list.push(row)
      map.set(row.merchant, list)
    }
    return [...map.entries()]
  }, [rows])

  const grandTotal = useMemo(() => rows.reduce((sum, r) => ({
    paid_n: sum.paid_n + num(r.paid_n),
    paid_amt: sum.paid_amt + num(r.paid_amt),
    declined_n: sum.declined_n + num(r.declined_n),
    deposit_fee_egp: sum.deposit_fee_egp + num(r.deposit_fee_egp),
    settlement_fee_egp: sum.settlement_fee_egp + num(r.settlement_fee_egp),
    net_egp: sum.net_egp + num(r.net_egp),
    paid_from_balance_egp: sum.paid_from_balance_egp + num(r.paid_from_balance_egp) + num(r.held_from_balance_egp),
    net_after_balance_egp: sum.net_after_balance_egp + num(r.net_after_balance_egp),
  }), { paid_n: 0, paid_amt: 0, declined_n: 0, deposit_fee_egp: 0, settlement_fee_egp: 0, net_egp: 0, paid_from_balance_egp: 0, net_after_balance_egp: 0 }), [rows])

  const undatedByMerchant = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) if (!map.has(row.merchant)) map.set(row.merchant, num(row.undated_n))
    return [...map.entries()].filter(([, n]) => n > 0)
  }, [rows])

  // Fee-rate info line: the deposit rate can vary per merchant (read from
  // master_merchant_fee_defaults); settlement is always the flat fallback
  // since the schema has no per-merchant column for it.
  const depositRateGroups = useMemo(() => {
    const map = new Map<number, Set<string>>()
    for (const row of rows) {
      const pct = Math.round(num(row.deposit_fee_rate) * 1000) / 10
      const set = map.get(pct) ?? new Set<string>()
      set.add(row.merchant)
      map.set(pct, set)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [rows])

  const chartData = useMemo(() => {
    const months = [...new Set(rows.map((r) => r.month))].sort()
    return months.map((m) => {
      const point: Record<string, string | number> = { month: formatMonthLabel(m, locale) }
      for (const [merchant, list] of grouped) {
        const row = list.find((r) => r.month === m)
        point[merchant] = row ? (viewMode === 'net' ? num(row.net_egp) : num(row.paid_amt)) : 0
      }
      return point
    })
  }, [rows, grouped, viewMode, locale])

  const chartMerchants = grouped.map(([merchant]) => merchant)

  const flatForExport = useMemo(() => rows.map((r) => ({
    ...r,
    monthLabel: formatMonthLabel(r.month, 'en') + (r.is_current_month ? ' (to date)' : ''),
  })), [rows])

  const exportRows = () => exportCsv(flatForExport, [
    { header: 'Month', key: 'month', value: (r) => r.monthLabel },
    { header: 'Merchant', key: 'merchant', value: (r) => r.merchant },
    { header: 'Paid count', key: 'paid_n', value: (r) => num(r.paid_n) },
    { header: 'Paid amount (EGP)', key: 'paid_amt', value: (r) => num(r.paid_amt).toFixed(2) },
    { header: 'Month share %', key: 'volume_share_pct', value: (r) => num(r.volume_share_pct).toFixed(2) },
    { header: 'Paid from balance (EGP)', key: 'paid_from_balance_egp', value: (r) => (num(r.paid_from_balance_egp) + num(r.held_from_balance_egp)).toFixed(2) },
    { header: 'Net remaining (EGP)', key: 'net_after_balance_egp', value: (r) => num(r.net_after_balance_egp).toFixed(2) },
    { header: 'Declined count', key: 'declined_n', value: (r) => num(r.declined_n) },
    { header: 'Deposit fee', key: 'deposit_fee_egp', value: (r) => num(r.deposit_fee_egp).toFixed(2) },
    { header: 'Settlement fee', key: 'settlement_fee_egp', value: (r) => num(r.settlement_fee_egp).toFixed(2) },
    { header: 'Net (EGP)', key: 'net_egp', value: (r) => num(r.net_egp).toFixed(2) },
    { header: 'Net (USDT)', key: 'net_usdt', value: (r) => (num(r.net_egp) / fx).toFixed(2) },
    { header: 'First day', key: 'first_day', value: (r) => r.first_day },
    { header: 'Last day', key: 'last_day', value: (r) => r.last_day },
    { header: 'Partial month', key: 'partial_month', value: (r) => r.partial_month ? 'yes' : '' },
    { header: 'Gap dates', key: 'gap_dates', value: (r) => r.gap_dates.join(' ') },
  ], 'merchant-monthly-volume')

  return <>
    <section className="page-head merchant-monthly-page">
      <div><h2>📆 {t('الحجم الشهري للتجار', 'Merchant Monthly Volume')}</h2><p className="page-sub">{t('تجميع شهري لكل تاجر مع الرسوم والصافي وأعلام جودة البيانات.', 'Monthly per-merchant aggregate with fees, net, and data-quality flags.')}</p></div>
      <div className="page-actions no-print">
        <button className="btn-ghost btn-sm" onClick={exportRows} disabled={loading || !rows.length}><Download size={15}/> CSV</button>
        <button className="btn-ghost btn-sm" onClick={() => window.print()} disabled={loading || !rows.length}><Printer size={15}/> PDF</button>
        {can('settlements', 'can_edit') && <button className="btn-primary btn-sm" onClick={() => setShowPaymentForm((value) => !value)}><PlusCircle size={15}/>{t('إضافة مدفوع من الرصيد', 'Add paid from balance')}</button>}
        <button className="btn-ghost btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{t('تحديث', 'Refresh')}</button>
      </div>
    </section>

    <section className="card filter-bar no-print">
      <MultiSelectFilter label={t('التاجر', 'Merchant')} allLabel={t('كل التجار', 'All merchants')} options={merchantOptions.map((value) => ({ value, label: value }))} value={selectedMerchants} onChange={setSelectedMerchants}/>
      <label className="filter-field"><CalendarRange size={14}/> {t('من شهر', 'From month')}<input className="login-input" type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)}/></label>
      <label className="filter-field">{t('إلى شهر', 'To month')}<input className="login-input" type="month" value={toMonth} onChange={(e) => setToMonth(e.target.value)}/></label>
      <div className="admin-tabs">
        <button type="button" className={`pill${viewMode === 'gross' ? ' active' : ''}`} onClick={() => setViewMode('gross')}>{t('إجمالي', 'Gross')}</button>
        <button type="button" className={`pill${viewMode === 'net' ? ' active' : ''}`} onClick={() => setViewMode('net')}>{t('صافي', 'Net')}</button>
      </div>
      <label className="filter-field">{t('سعر USDT', 'USDT rate')}<input className="login-input mono" type="number" min="0.01" step="0.01" value={fxRate} onChange={(e) => setFxRate(e.target.value)}/></label>
    </section>

    {showPaymentForm && can('settlements', 'can_edit') && <section className="card merchant-monthly-payment-card no-print">
      <div className="recent-head"><div><h3>{t('إضافة مبلغ مدفوع من رصيد التاجر', 'Add paid amount from merchant balance')}</h3><p className="cell-sub">{t('سيُخصم المبلغ من صافي الشهر ويظهر في عمود المدفوع من الرصيد.', 'The amount is deducted from monthly net and shown in the balance-paid column.')}</p></div></div>
      <form className="settlement-payment-form" onSubmit={addPayment}>
        <select className="login-input" required value={paymentForm.merchant} onChange={(e) => setPaymentForm({ ...paymentForm, merchant: e.target.value })}><option value="">{t('اختر التاجر', 'Select merchant')}</option>{merchantOptions.map((merchant) => <option key={merchant} value={merchant}>{merchant}</option>)}</select>
        <input className="login-input" type="month" required value={paymentForm.settlement_month} onChange={(e) => setPaymentForm({ ...paymentForm, settlement_month: e.target.value })}/>
        <input className="login-input" type="number" min="0.01" step="0.01" required placeholder={t('المبلغ المدفوع من الرصيد', 'Amount paid from balance')} value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}/>
        <input className="login-input" type="number" min="0.01" step="0.01" placeholder={t('سعر USDT للشهر', 'Monthly USDT rate')} value={paymentForm.usdt_rate} onChange={(e) => setPaymentForm({ ...paymentForm, usdt_rate: e.target.value })}/>
        <input className="login-input" type="number" min="0" step="0.01" placeholder={t('Pay-in %', 'Pay-in %')} value={paymentForm.payin_fee_percent} onChange={(e) => setPaymentForm({ ...paymentForm, payin_fee_percent: e.target.value })}/>
        <input className="login-input" type="number" min="0" step="0.01" placeholder={t('Pay-in ثابت / معاملة', 'Pay-in fixed / trx')} value={paymentForm.payin_fee_fixed} onChange={(e) => setPaymentForm({ ...paymentForm, payin_fee_fixed: e.target.value })}/>
        <input className="login-input" type="number" min="0" step="0.01" placeholder={t('Pay-out %', 'Pay-out %')} value={paymentForm.payout_fee_percent} onChange={(e) => setPaymentForm({ ...paymentForm, payout_fee_percent: e.target.value })}/>
        <input className="login-input" type="number" min="0" step="0.01" placeholder={t('Pay-out ثابت / معاملة', 'Pay-out fixed / trx')} value={paymentForm.payout_fee_fixed} onChange={(e) => setPaymentForm({ ...paymentForm, payout_fee_fixed: e.target.value })}/>
        <input className="login-input" type="date" required value={paymentForm.settlement_date} onChange={(e) => setPaymentForm({ ...paymentForm, settlement_date: e.target.value })}/>
        <input className="login-input" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setPaymentForm({ ...paymentForm, proof: e.target.files?.[0] ?? null })}/>
        <input className="login-input" placeholder={t('ملاحظة (اختياري)', 'Note (optional)')} value={paymentForm.note} onChange={(e) => setPaymentForm({ ...paymentForm, note: e.target.value })}/>
        <button className="btn-primary" disabled={paymentBusy}>{paymentBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ الدفعة', 'Save payment')}</button>
      </form>
    </section>}
    {can('settlements', 'can_edit') && balancePayments.length > 0 && <section className="card recent-card no-print"><div className="recent-head"><h3>{t('مدفوعات الرصيد القابلة للتعديل', 'Editable balance payments')}</h3></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('التاجر','Merchant')}</th><th>{t('الشهر','Month')}</th><th>{t('المبلغ','Amount')}</th><th>{t('تاريخ التسوية','Settlement date')}</th><th>{t('الإثبات','Proof')}</th><th /></tr></thead><tbody>{balancePayments.map((payment) => <tr key={payment.id}><td>{payment.merchant}</td><td className="mono">{payment.settlement_month.slice(0, 7)}</td><td><input className="login-input mono" type="number" min="0.01" step="0.01" defaultValue={payment.amount} onBlur={async (e) => { const amount = Number(e.currentTarget.value); if (!Number.isFinite(amount) || amount <= 0 || amount === Number(payment.amount)) return; try { await api(`/api/settlements/payments/${payment.id}`, { method: 'PATCH', body: JSON.stringify({ amount }) }); await loadPayments(); await load() } catch (error) { setError(error instanceof ApiError ? error.message : t('تعذر تعديل المبلغ','Could not update amount')) } }} /></td><td className="mono">{payment.settlement_date ?? '—'}</td><td>{payment.proof_url ? <a href={payment.proof_url} target="_blank" rel="noreferrer">{payment.proof_file_name ?? t('عرض','View')}</a> : '—'}</td><td className="cell-sub">{t('عدّل المبلغ ثم اخرج من الحقل للحفظ','Edit amount then leave the field to save')}</td></tr>)}</tbody></table></div></section>}

    {/* Static text stand-in for the interactive filter bar above, which
        is hidden from print — a dropdown widget prints as nothing
        useful, so the applied filters need a plain-text form instead. */}
    <p className="cell-sub print-only merchant-monthly-print-summary">
      {t('التجار', 'Merchants')}: {selectedMerchants.length ? selectedMerchants.join(', ') : t('الكل', 'All')}
      {' · '}{t('الفترة', 'Period')}: {formatMonthLabel(monthKeyToFirstDay(fromMonth), locale)} – {formatMonthLabel(monthKeyToFirstDay(toMonth), locale)}
      {' · '}{t('العرض', 'View')}: {viewMode === 'net' ? t('صافي', 'Net') : t('إجمالي', 'Gross')}
      {' · '}{t('تم الإنشاء', 'Generated')}: {new Date().toLocaleString()}
    </p>

    {error && <div className="card warn">{error}</div>}

    <p className="cell-sub merchant-monthly-fee-line">
      {t('الرسوم المستخدمة', 'Fees used')}: {t('رسوم الإيداع', 'Deposit fee')} {depositRateGroups.length
        ? depositRateGroups.map(([pct, set]) => `${pct}%${pct === DEFAULT_DEPOSIT_FEE_PCT ? ` (${t('افتراضي', 'default')})` : ` (${[...set].join(', ')})`}`).join(' · ')
        : `${DEFAULT_DEPOSIT_FEE_PCT}% (${t('افتراضي', 'default')})`}
      {' · '}{t('رسوم التسوية', 'Settlement fee')} {DEFAULT_SETTLEMENT_FEE_PCT}% ({t('ثابتة — لا يوجد استثناء لكل تاجر في قاعدة البيانات', 'fixed — no per-merchant override exists in the schema')})
      {' · '}FX {fx.toFixed(2)}
    </p>

    <section className="card recent-card no-print">
      <div className="recent-head"><h3>{t('الحجم المدفوع شهرياً', 'Paid volume by month')}</h3><span className="cell-sub">{viewMode === 'net' ? t('صافي EGP', 'Net EGP') : t('إجمالي EGP', 'Gross EGP')}</span></div>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <RechartsTooltip formatter={(v) => money(Number(v), 'EGP')} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {chartMerchants.map((merchant, i) => (
              <Bar key={merchant} dataKey={merchant} fill={BAR_COLORS[i % BAR_COLORS.length]} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>

    <section className="card recent-card merchant-monthly-table-card">
      <div className="recent-head"><h3>{t('التفصيل الشهري', 'Monthly breakdown')}</h3><span className="cell-sub">{rows.length.toLocaleString()} {t('صف', 'rows')}</span></div>
      {isMobile ? (
        <div className="risk-card-list">
          {grouped.map(([merchant, list]) => (
            <div key={merchant}>
              {list.map((row) => (
                <div key={row.month} className="risk-row-card">
                  <div className="risk-row-card-head"><strong>{merchant}</strong><span className="mono">{money(num(row.net_egp), 'EGP')}</span></div>
                  <div className="cell-sub">{formatMonthLabel(row.month, locale)}{row.is_current_month ? ` (${t('حتى الآن', 'to date')})` : ''}</div>
                  <div className="cell-sub">{t('مدفوع', 'Paid')} {num(row.paid_n)} · {money(num(row.paid_amt), 'EGP')} · {t('نسبة الشهر', 'Month share')} {num(row.volume_share_pct).toFixed(2)}%</div>
                  <div className="cell-sub">{t('مدفوع من الرصيد', 'Paid from balance')} {money(num(row.paid_from_balance_egp) + num(row.held_from_balance_egp), 'EGP')} · {t('الصافي المتبقي', 'Net remaining')} {money(num(row.net_after_balance_egp), 'EGP')}</div>
                  <div className="cell-sub">{t('رسوم الإيداع', 'Deposit fee')} {money(num(row.deposit_fee_egp), 'EGP')} · {t('رسوم التسوية', 'Settlement fee')} {money(num(row.settlement_fee_egp), 'EGP')}</div>
                  <div className="cell-sub">{formatDay(row.first_day)} – {formatDay(row.last_day)}</div>
                  {(row.partial_month || row.gap_dates.length > 0) && <div className="chip-row">
                    {row.partial_month && <span className="pay-status-badge st-pending" title={t('الشهر غير مكتمل', 'Month is not fully covered')}><AlertTriangle size={11}/> {t('شهر جزئي', 'Partial month')}</span>}
                    {row.gap_dates.length > 0 && <span className="pay-status-badge st-declined" title={compressDateRanges(row.gap_dates)}><Clock3 size={11}/> {t('فجوة', 'Gap')}</span>}
                  </div>}
                </div>
              ))}
            </div>
          ))}
          {!loading && !rows.length && <p className="maven-empty">{t('لا توجد بيانات في هذا النطاق.', 'No data in this range.')}</p>}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table">
        <thead><tr>
          <th>{t('الشهر', 'Month')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('عدد المدفوع', 'Paid count')}</th>
          <th>{t('المبلغ المدفوع (EGP)', 'Paid amount (EGP)')}</th><th>{t('نسبة الشهر', 'Month share')}</th><th>{t('عدد المرفوض', 'Declined count')}</th><th>{t('مدفوع من الرصيد', 'Paid from balance')}</th><th>{t('الصافي المتبقي', 'Net remaining')}</th>
          <th>{t('رسوم الإيداع', 'Deposit fee')}</th><th>{t('رسوم التسوية', 'Settlement fee')}</th>
          <th>{t('صافي (EGP)', 'Net (EGP)')}</th><th>{t('صافي (USDT)', 'Net (USDT)')}</th>
          <th>{t('أول يوم', 'First day')}</th><th>{t('آخر يوم', 'Last day')}</th><th>{t('أعلام', 'Flags')}</th>
        </tr></thead>
        <tbody>
          {grouped.map(([merchant, list]) => {
            const subtotal = list.reduce((sum, r) => ({
              paid_n: sum.paid_n + num(r.paid_n), paid_amt: sum.paid_amt + num(r.paid_amt), declined_n: sum.declined_n + num(r.declined_n),
              deposit_fee_egp: sum.deposit_fee_egp + num(r.deposit_fee_egp), settlement_fee_egp: sum.settlement_fee_egp + num(r.settlement_fee_egp), net_egp: sum.net_egp + num(r.net_egp),
            }), { paid_n: 0, paid_amt: 0, declined_n: 0, deposit_fee_egp: 0, settlement_fee_egp: 0, net_egp: 0 })
            return <Fragment key={merchant}>
              {list.map((row) => <tr key={`${merchant}-${row.month}`}>
                <td className="mono">{formatMonthLabel(row.month, locale)}{row.is_current_month ? ` (${t('حتى الآن', 'to date')})` : ''}</td>
                <td><strong>{row.merchant}</strong></td>
                <td className="mono">{num(row.paid_n).toLocaleString()}</td>
                <td className="mono">{money(num(row.paid_amt), 'EGP')}</td>
                <td className="mono">{num(row.volume_share_pct).toFixed(2)}%</td><td className="mono">{num(row.declined_n).toLocaleString()}</td><td className="mono">{money(num(row.paid_from_balance_egp) + num(row.held_from_balance_egp), 'EGP')}</td><td className="mono">{money(num(row.net_after_balance_egp), 'EGP')}</td>
                <td className="mono">{money(num(row.deposit_fee_egp), 'EGP')}</td>
                <td className="mono">{money(num(row.settlement_fee_egp), 'EGP')}</td>
                <td className="mono">{money(num(row.net_egp), 'EGP')}</td>
                <td className="mono">{(num(row.net_egp) / fx).toFixed(2)} USDT</td>
                <td className="mono">{formatDay(row.first_day)}</td>
                <td className="mono">{formatDay(row.last_day)}</td>
                <td>{row.partial_month && <span className="pay-status-badge st-pending merchant-monthly-flag" title={t('الشهر غير مكتمل', 'Month is not fully covered')}><AlertTriangle size={11}/> {t('جزئي', 'Partial')}</span>}
                  {row.gap_dates.length > 0 && <span className="pay-status-badge st-declined merchant-monthly-flag" title={compressDateRanges(row.gap_dates)}><Clock3 size={11}/> {t('فجوة', 'Gap')}</span>}</td>
              </tr>)}
              <tr className="merchant-monthly-subtotal">
                <td colSpan={2}>{t('إجمالي', 'Subtotal')} — {merchant}</td>
                <td className="mono">{subtotal.paid_n.toLocaleString()}</td>
                <td className="mono">{money(subtotal.paid_amt, 'EGP')}</td>
                <td className="mono">—</td><td className="mono">{subtotal.declined_n.toLocaleString()}</td><td colSpan={2}>—</td>
                <td className="mono">{money(subtotal.deposit_fee_egp, 'EGP')}</td>
                <td className="mono">{money(subtotal.settlement_fee_egp, 'EGP')}</td>
                <td className="mono">{money(subtotal.net_egp, 'EGP')}</td>
                <td className="mono">{(subtotal.net_egp / fx).toFixed(2)} USDT</td>
                <td colSpan={3} />
              </tr>
            </Fragment>
          })}
          {!loading && !rows.length && <tr><td colSpan={16} className="sidebar-hint">{t('لا توجد بيانات في هذا النطاق.', 'No data in this range.')}</td></tr>}
        </tbody>
        <tfoot><tr>
          <th colSpan={2}>{t('الإجمالي الكلي', 'Grand total')}</th>
          <th className="mono">{grandTotal.paid_n.toLocaleString()}</th>
          <th className="mono">{money(grandTotal.paid_amt, 'EGP')}</th>
          <th className="mono">—</th><th className="mono">{grandTotal.declined_n.toLocaleString()}</th><th className="mono">{money(grandTotal.paid_from_balance_egp, 'EGP')}</th><th className="mono">{money(grandTotal.net_after_balance_egp, 'EGP')}</th>
          <th className="mono">{money(grandTotal.deposit_fee_egp, 'EGP')}</th>
          <th className="mono">{money(grandTotal.settlement_fee_egp, 'EGP')}</th>
          <th className="mono">{money(grandTotal.net_egp, 'EGP')}</th>
          <th className="mono">{(grandTotal.net_egp / fx).toFixed(2)} USDT</th>
          <th colSpan={3} />
        </tr></tfoot>
      </table></div>
      )}
      <div className="merchant-monthly-undated">
        {undatedByMerchant.length === 0
          ? <span className="cell-sub">{t('لا توجد معاملات بدون تاريخ.', 'No undated transactions.')}</span>
          : <span className="cell-sub danger-text">⚠️ {t('معاملات بدون تاريخ (لم تُدرج في التجميع الشهري)', 'Undated transactions (not included in the monthly aggregate)')}: {undatedByMerchant.map(([m, n]) => `${m}: ${n}`).join(' · ')}</span>}
      </div>
    </section>
  </>
}
