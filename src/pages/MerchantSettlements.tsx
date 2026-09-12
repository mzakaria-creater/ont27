import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Download, Printer, RefreshCw } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type MerchantTotal = { merchant: string; master: string; count: number; gross: number; fees: number; commission: number }
type Report = { byMaster?: Array<{ master: string; merchants?: Array<{ merchant: string; paid_count: number; paid_amount: number; commission: number; fees: number }> }> }
type Payment = { merchant: string; amount: number; usdt_rate: number | null; settlement_month: string; paid_at: string }

const MONTHS = ['2026-07', '2026-08', '2026-09']
const DEFAULT_RATE = 52.6
const DEPOSIT_FEE = 0.055
const SETTLEMENT_FEE = 0.06

export default function MerchantSettlements() {
  const { t } = useLocale()
  const [reports, setReports] = useState<Array<{ month: string; report: Report }>>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [masters, setMasters] = useState<string[]>([])
  const [merchants, setMerchants] = useState<string[]>([])
  const [masterFilter, setMasterFilter] = useState<string[]>([])
  const [merchantFilter, setMerchantFilter] = useState<string[]>([])
  const [rate, setRate] = useState(String(DEFAULT_RATE))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [monthly, paymentResult] = await Promise.all([
        Promise.all(MONTHS.map(async (month) => {
          const end = new Date(`${month}-01T00:00:00+03:00`)
          end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
          const report = await api<Report>(`/api/reports?from=${month}-01&to=${end.toISOString().slice(0, 10)}`)
          return { month, report }
        })),
        api<{ payments?: Payment[] }>('/api/settlements/payments'),
      ])
      setReports(monthly); setPayments(paymentResult.payments ?? [])
      const masterSet = new Set<string>(); const merchantSet = new Set<string>()
      monthly.forEach(({ report }) => (report.byMaster ?? []).forEach((master) => {
        if (master.master && master.master !== 'Unassigned') masterSet.add(master.master)
        ;(master.merchants ?? []).forEach((merchant) => merchant.merchant && merchant.merchant !== 'Unassigned' && merchantSet.add(merchant.merchant))
      }))
      setMasters([...masterSet].sort()); setMerchants([...merchantSet].sort())
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التسويات.', 'You do not have permission to view settlements.') : t('تعذّر تحميل تقرير التسويات.', 'Failed to load settlement report.'))
    } finally { setLoading(false) }
  }, [t])

  useEffect(() => { void load() }, [load])

  const monthlyTotals = useMemo(() => reports.flatMap(({ month, report }) => {
    const rows: MerchantTotal[] = []
    ;(report.byMaster ?? []).forEach((master) => (master.merchants ?? []).forEach((merchant) => {
      if (masterFilter.length && !masterFilter.includes(master.master)) return
      if (merchantFilter.length && !merchantFilter.includes(merchant.merchant)) return
      const gross = Number(merchant.paid_amount ?? 0)
      rows.push({ merchant: merchant.merchant, master: master.master, count: Number(merchant.paid_count ?? 0), gross, fees: Number(merchant.fees ?? 0), commission: Number(merchant.commission ?? 0) })
    }))
    return rows.map((row) => ({ month, ...row }))
  }), [reports, masterFilter, merchantFilter])

  const totals = monthlyTotals.reduce((sum, row) => ({ count: sum.count + row.count, gross: sum.gross + row.gross, fees: sum.fees + row.fees, commission: sum.commission + row.commission }), { count: 0, gross: 0, fees: 0, commission: 0 })
  const fxRate = Number(rate) > 0 ? Number(rate) : DEFAULT_RATE
  const afterDeposit = totals.gross * (1 - DEPOSIT_FEE)
  const settlementFee = afterDeposit * SETTLEMENT_FEE
  const netUsdt = (afterDeposit - settlementFee) / fxRate
  const settledUsdt = payments.filter((payment) => !merchantFilter.length || merchantFilter.includes(payment.merchant)).reduce((sum, payment) => sum + (Number(payment.amount) / Number(payment.usdt_rate || fxRate)), 0)
  const balanceUsdt = Math.max(0, netUsdt - settledUsdt)

  const exportCsv = () => {
    const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const lines = [['Month', 'Master merchant', 'Sub merchant', 'Paid transactions', 'Gross EGP', 'Deposit fee EGP', 'Settlement fee EGP', 'Net USDT'], ...monthlyTotals.map((row) => {
      const after = row.gross * (1 - DEPOSIT_FEE); return [row.month, row.master, row.merchant, row.count, row.gross.toFixed(2), (row.gross * DEPOSIT_FEE).toFixed(2), (after * SETTLEMENT_FEE).toFixed(2), ((after * (1 - SETTLEMENT_FEE)) / fxRate).toFixed(2)]
    })].map((line) => line.map(esc).join(','))
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })); link.download = 'merchant-settlement-report.csv'; link.click(); URL.revokeObjectURL(link.href)
  }

  return <PanelShell>
    <section className="page-head">
      <div><h2>🧾 {t('تسويات التجار', 'Merchant settlements')}</h2><p className="page-sub">{t('تقرير حي للتجار الرئيسي والفرعي مع إجمالي EGP وUSDT والرصيد المستحق.', 'Live master/sub-merchant settlement report with EGP, USDT, and balance due.')}</p></div>
      <div className="page-actions"><button className="btn-ghost btn-sm" onClick={exportCsv} disabled={loading}><Download size={15}/> CSV</button><button className="btn-ghost btn-sm" onClick={() => window.print()} disabled={loading}><Printer size={15}/> PDF / Print</button><button className="btn-ghost btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{t('تحديث', 'Refresh')}</button></div>
    </section>
    <section className="card filter-bar">
      <span className="reports-range"><CalendarDays size={15}/> Jul–Sep 2026 · Africa/Cairo</span>
      <MultiSelectFilter label={t('الشركة', 'Master')} allLabel={t('كل الشركات', 'All masters')} options={masters.map((value) => ({ value, label: value }))} value={masterFilter} onChange={setMasterFilter}/>
      <MultiSelectFilter label={t('التاجر الفرعي', 'Sub-merchant')} allLabel={t('كل التجار', 'All merchants')} options={merchants.map((value) => ({ value, label: value }))} value={merchantFilter} onChange={setMerchantFilter}/>
      <label className="filter-field">{t('سعر USDT', 'USDT rate')}<input className="login-input mono" type="number" min="0.01" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)}/></label>
    </section>
    {error && <div className="card warn">{error}</div>}
    <section className="kpi-grid">
      <article className="kpi-card"><span className="kpi-icon">💰</span><div className="kpi-value">{money(totals.gross, 'EGP')}</div><div className="kpi-label">{t('إجمالي PayIn المعتمد', 'Total approved PayIn')}</div></article>
      <article className="kpi-card"><span className="kpi-icon">🪙</span><div className="kpi-value">{netUsdt.toFixed(2)} USDT</div><div className="kpi-label">{t('صافي التسوية', 'Net settlement')}</div></article>
      <article className="kpi-card"><span className="kpi-icon">✅</span><div className="kpi-value">{settledUsdt.toFixed(2)} USDT</div><div className="kpi-label">{t('تمت تسويته', 'Already settled')}</div></article>
      <article className="kpi-card"><span className="kpi-icon">⚠️</span><div className="kpi-value">{balanceUsdt.toFixed(2)} USDT</div><div className="kpi-label">{t('الرصيد المستحق', 'Balance due')}</div></article>
    </section>
    <section className="card recent-card">
      <div className="recent-head"><div><h3>{t('التفصيل الشهري', 'Monthly breakdown')}</h3><span className="cell-sub">{totals.count.toLocaleString()} {t('معاملة مدفوعة', 'paid transactions')} · fee assumptions: 5.5% + 6%</span></div></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الشهر','Month')}</th><th>{t('الشركة','Master')}</th><th>{t('التاجر','Sub-merchant')}</th><th>{t('المعاملات','Paid')}</th><th>Gross EGP</th><th>Deposit fee</th><th>Settlement fee</th><th>Net USDT</th></tr></thead><tbody>{monthlyTotals.map((row) => { const after = row.gross * (1 - DEPOSIT_FEE); return <tr key={`${row.month}-${row.master}-${row.merchant}`}><td className="mono">{row.month}</td><td>{row.master}</td><td><strong>{row.merchant}</strong></td><td className="mono">{row.count.toLocaleString()}</td><td className="mono">{money(row.gross, 'EGP')}</td><td className="mono">{money(row.gross * DEPOSIT_FEE, 'EGP')}</td><td className="mono">{money(after * SETTLEMENT_FEE, 'EGP')}</td><td className="mono">{((after * (1 - SETTLEMENT_FEE)) / fxRate).toFixed(2)} USDT</td></tr> })}{!loading && monthlyTotals.length === 0 && <tr><td colSpan={8} className="sidebar-hint">{t('لا توجد بيانات في النطاق.', 'No settlement data in this range.')}</td></tr>}</tbody><tfoot><tr><th colSpan={3}>{t('الإجمالي','Total')}</th><th className="mono">{totals.count.toLocaleString()}</th><th className="mono">{money(totals.gross, 'EGP')}</th><th className="mono">{money(totals.gross * DEPOSIT_FEE, 'EGP')}</th><th className="mono">{money(settlementFee, 'EGP')}</th><th className="mono">{netUsdt.toFixed(2)} USDT</th></tr></tfoot></table></div>
    </section>
  </PanelShell>
}
