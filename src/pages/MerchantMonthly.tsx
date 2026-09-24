import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, CalendarRange, Clock3, Download, Printer, RefreshCw } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MultiSelectFilter from '../components/MultiSelectFilter'
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
}

const DEFAULT_RATE = 52.6
const DEFAULT_DEPOSIT_FEE_PCT = 5.5
const DEFAULT_SETTLEMENT_FEE_PCT = 6
const BAR_COLORS = ['#f7b84b', '#4b9bf7', '#7fd47f', '#e56b8c', '#b98af7', '#5cd6c0', '#f79a4b', '#8aa6f7']

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function monthKey(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
function addMonthsKey(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return monthKey(d)
}
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
  const isMobile = useIsMobile()
  const [merchantOptions, setMerchantOptions] = useState<string[]>([])
  const [selectedMerchants, setSelectedMerchants] = useState<string[]>([])
  const [fromMonth, setFromMonth] = useState(() => addMonthsKey(monthKey(new Date()), -5))
  const [toMonth, setToMonth] = useState(() => monthKey(new Date()))
  const [viewMode, setViewMode] = useState<'gross' | 'net'>('gross')
  const [fxRate, setFxRate] = useState(String(DEFAULT_RATE))
  const [rows, setRows] = useState<MonthlyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
  }), { paid_n: 0, paid_amt: 0, declined_n: 0, deposit_fee_egp: 0, settlement_fee_egp: 0, net_egp: 0 }), [rows])

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

  return <PanelShell>
    <section className="page-head merchant-monthly-page">
      <div><h2>📆 {t('الحجم الشهري للتجار', 'Merchant Monthly Volume')}</h2><p className="page-sub">{t('تجميع شهري لكل تاجر مع الرسوم والصافي وأعلام جودة البيانات.', 'Monthly per-merchant aggregate with fees, net, and data-quality flags.')}</p></div>
      <div className="page-actions no-print">
        <button className="btn-ghost btn-sm" onClick={exportRows} disabled={loading || !rows.length}><Download size={15}/> CSV</button>
        <button className="btn-ghost btn-sm" onClick={() => window.print()} disabled={loading || !rows.length}><Printer size={15}/> PDF</button>
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
                  <div className="cell-sub">{t('مدفوع', 'Paid')} {num(row.paid_n)} · {money(num(row.paid_amt), 'EGP')} · {t('مرفوض', 'Declined')} {num(row.declined_n)}</div>
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
          <th>{t('المبلغ المدفوع (EGP)', 'Paid amount (EGP)')}</th><th>{t('عدد المرفوض', 'Declined count')}</th>
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
                <td className="mono">{num(row.declined_n).toLocaleString()}</td>
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
                <td className="mono">{subtotal.declined_n.toLocaleString()}</td>
                <td className="mono">{money(subtotal.deposit_fee_egp, 'EGP')}</td>
                <td className="mono">{money(subtotal.settlement_fee_egp, 'EGP')}</td>
                <td className="mono">{money(subtotal.net_egp, 'EGP')}</td>
                <td className="mono">{(subtotal.net_egp / fx).toFixed(2)} USDT</td>
                <td colSpan={3} />
              </tr>
            </Fragment>
          })}
          {!loading && !rows.length && <tr><td colSpan={12} className="sidebar-hint">{t('لا توجد بيانات في هذا النطاق.', 'No data in this range.')}</td></tr>}
        </tbody>
        <tfoot><tr>
          <th colSpan={2}>{t('الإجمالي الكلي', 'Grand total')}</th>
          <th className="mono">{grandTotal.paid_n.toLocaleString()}</th>
          <th className="mono">{money(grandTotal.paid_amt, 'EGP')}</th>
          <th className="mono">{grandTotal.declined_n.toLocaleString()}</th>
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
  </PanelShell>
}
