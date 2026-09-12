import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, Download, Printer, RefreshCw } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Settlement = { id: string; sub_merchant_id: string; master_merchant: string | null; sub_merchant: string | null; settlement_period: string; total_net_usdt: number; total_net_egp: number; already_settled_usdt: number; already_settled_egp: number; balance_due_usdt: number; balance_due_egp: number; status: string }
type MonthlyRow = { id: string; sub_merchant_id: string; master_merchant: string | null; sub_merchant: string | null; transaction_month: string; gross_amount_egp: number; deposit_fee_egp: number; after_deposit_fee_egp: number; after_deposit_fee_usdt: number; settlement_fee_usdt: number; net_amount_usdt: number; net_amount_egp: number; fx_rate: number }
type StructuredResponse = { masters?: Array<{ name: string }>; sub_merchants?: Array<{ name: string; master_merchant: string | null }>; settlements?: Settlement[]; monthly?: MonthlyRow[] }

const DEFAULT_RATE = 52.6
const DEPOSIT_FEE = 0.055
const SETTLEMENT_FEE = 0.06

export default function MerchantSettlements() {
  const { t } = useLocale()
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [monthlyRows, setMonthlyRows] = useState<MonthlyRow[]>([])
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
      const result = await api<StructuredResponse>('/api/reports/merchant-settlements')
      const structuredSettlements = result.settlements ?? []; const structuredMonthly = result.monthly ?? []
      setSettlements(structuredSettlements); setMonthlyRows(structuredMonthly)
      const masterSet = new Set<string>(); const merchantSet = new Set<string>()
      structuredSettlements.forEach((row) => { if (row.master_merchant) masterSet.add(row.master_merchant); if (row.sub_merchant) merchantSet.add(row.sub_merchant) })
      structuredMonthly.forEach((row) => { if (row.master_merchant) masterSet.add(row.master_merchant); if (row.sub_merchant) merchantSet.add(row.sub_merchant) })
      setMasters([...masterSet].sort()); setMerchants([...merchantSet].sort())
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التسويات.', 'You do not have permission to view settlements.') : t('تعذّر تحميل تقرير التسويات.', 'Failed to load settlement report.'))
    } finally { setLoading(false) }
  }, [t])

  useEffect(() => { void load() }, [load])

  const monthlyTotals = useMemo(() => monthlyRows.filter((row) => (!masterFilter.length || masterFilter.includes(row.master_merchant ?? '')) && (!merchantFilter.length || merchantFilter.includes(row.sub_merchant ?? ''))), [monthlyRows, masterFilter, merchantFilter])

  const totals = monthlyTotals.reduce((sum, row) => ({ count: sum.count + 1, gross: sum.gross + Number(row.gross_amount_egp), fees: sum.fees + Number(row.deposit_fee_egp), commission: sum.commission }), { count: 0, gross: 0, fees: 0, commission: 0 })
  const fxRate = Number(rate) > 0 ? Number(rate) : DEFAULT_RATE
  const afterDeposit = totals.gross * (1 - DEPOSIT_FEE)
  const settlementFee = afterDeposit * SETTLEMENT_FEE
  const netUsdt = (afterDeposit - settlementFee) / fxRate
  const selectedSettlements = settlements.filter((row) => (!masterFilter.length || masterFilter.includes(row.master_merchant ?? '')) && (!merchantFilter.length || merchantFilter.includes(row.sub_merchant ?? '')))
  const settledUsdt = selectedSettlements.reduce((sum, row) => sum + Number(row.already_settled_usdt), 0)
  const balanceUsdt = selectedSettlements.length ? selectedSettlements.reduce((sum, row) => sum + Number(row.balance_due_usdt), 0) : Math.max(0, netUsdt - settledUsdt)

  const exportCsv = () => {
    const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const lines = [['Month', 'Master merchant', 'Sub merchant', 'Transactions', 'Gross EGP', 'Deposit fee', 'Settlement fee', 'Net USDT'], ...monthlyTotals.map((row) => {
      return [row.transaction_month, row.master_merchant, row.sub_merchant, 1, Number(row.gross_amount_egp).toFixed(2), Number(row.deposit_fee_egp).toFixed(2), Number(row.settlement_fee_usdt).toFixed(2), Number(row.net_amount_usdt).toFixed(2)]
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
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الشهر','Month')}</th><th>{t('الشركة','Master')}</th><th>{t('التاجر','Sub-merchant')}</th><th>{t('المعاملات','Transactions')}</th><th>Gross EGP</th><th>Deposit fee</th><th>Settlement fee</th><th>Net USDT</th></tr></thead><tbody>{monthlyTotals.map((row) => <tr key={row.id}><td className="mono">{row.transaction_month}</td><td>{row.master_merchant ?? '—'}</td><td><strong>{row.sub_merchant ?? '—'}</strong></td><td className="mono">1</td><td className="mono">{money(row.gross_amount_egp, 'EGP')}</td><td className="mono">{money(row.deposit_fee_egp, 'EGP')}</td><td className="mono">{money(row.settlement_fee_usdt, 'USDT')}</td><td className="mono">{Number(row.net_amount_usdt).toFixed(2)} USDT</td></tr>)}{!loading && monthlyTotals.length === 0 && <tr><td colSpan={8} className="sidebar-hint">{t('لا توجد بيانات في النطاق.', 'No settlement data in this range.')}</td></tr>}</tbody><tfoot><tr><th colSpan={3}>{t('الإجمالي','Total')}</th><th className="mono">{totals.count.toLocaleString()}</th><th className="mono">{money(totals.gross, 'EGP')}</th><th className="mono">{money(totals.fees, 'EGP')}</th><th className="mono">{money(settlementFee, 'USDT')}</th><th className="mono">{netUsdt.toFixed(2)} USDT</th></tr></tfoot></table></div>
    </section>
  </PanelShell>
}
