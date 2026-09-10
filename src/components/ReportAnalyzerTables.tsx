import { Fragment, useMemo, useState } from 'react'
import { Activity, Building2, ChevronDown, ChevronRight, PlugZap, Search, ShieldAlert, ShieldCheck, Star, WalletCards } from 'lucide-react'
import MerchantLogo from './MerchantLogo'
import MethodLogo from './MethodLogo'
import { money } from '../lib/deposits'

export interface CompanyMerchantRow {
  merchant: string
  count: number
  amount: number
  paid_count: number
  paid_amount: number
  average_paid: number
  commission_collected: number
  conversion_rate: number
}

export interface CompanyReportRow {
  master: string
  count: number
  amount: number
  paid_count: number
  paid_amount: number
  average_paid: number
  commission_collected: number
  conversion_rate: number
  risk_level: 'low' | 'medium' | 'high'
  merchants: CompanyMerchantRow[]
}

export interface ReceiverReportRow {
  receiver: string
  count: number
  amount: number
  average_paid: number
  share: number
  merchants: string[]
  methods: string[]
}

export interface PaymentRailReportRow {
  key: string
  label: string
  family: string
  readiness: string
  count: number
  amount: number
  paid_count: number
  paid_amount: number
  average_paid: number
  success_rate: number
  active: boolean
}

interface SharedProps {
  locale: string
  t: (arabic: string, english: string) => string
}

const numeric = (value: number, locale: string) => value.toLocaleString(locale, { maximumFractionDigits: 0 })

export function CompanySummaryReport({ rows, locale, t }: SharedProps & { rows: CompanyReportRow[] }) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => !needle || row.master.toLowerCase().includes(needle) || row.merchants.some((merchant) => merchant.merchant.toLowerCase().includes(needle)))
  }, [query, rows])
  const totals = useMemo(() => filtered.reduce((sum, row) => ({
    requests: sum.requests + row.count,
    value: sum.value + row.amount,
    paid: sum.paid + row.paid_count,
    paidAmount: sum.paidAmount + row.paid_amount,
    commission: sum.commission + row.commission_collected,
  }), { requests: 0, value: 0, paid: 0, paidAmount: 0, commission: 0 }), [filtered])
  const conversion = totals.requests ? totals.paid / totals.requests * 100 : 0
  const toggle = (master: string) => setExpanded((current) => current.includes(master) ? current.filter((item) => item !== master) : [...current, master])

  return <section className="report-analyzer" aria-labelledby="company-report-title">
    <div className="report-analyzer-head">
      <div><span className="reports-eyebrow"><Building2 size={14}/>{t('تحليل الشركات', 'COMPANY ANALYSIS')}</span><h3 id="company-report-title">{t('جدول الشركات — إجمالي إيداعات الفترة (PAID)', 'Companies — paid deposits in selected period')}</h3><p>{t('اضغط على الشركة لعرض التجار التابعين لها.', 'Open a company row to inspect its merchants.')}</p></div>
      <label className="report-analyzer-search"><Search size={16}/><span className="sr-only">{t('بحث في الشركات', 'Search companies')}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('بحث باسم الشركة أو التاجر…', 'Search company or merchant…')}/></label>
    </div>

    <div className="report-analyzer-kpis">
      <article><small>{t('الشركات', 'Companies')}</small><strong>{filtered.length.toLocaleString(locale)}</strong></article>
      <article><small>{t('إجمالي الطلبات', 'Total requests')}</small><strong>{numeric(totals.requests, locale)}</strong></article>
      <article><small>{t('معاملات PAID', 'PAID transactions')}</small><strong className="positive-text">{numeric(totals.paid, locale)}</strong></article>
      <article><small>{t('إجمالي PAID', 'PAID volume')}</small><strong className="positive-text">{money(totals.paidAmount, 'EGP')}</strong></article>
      <article><small>{t('معدل التحويل', 'Conversion')}</small><strong>{conversion.toFixed(1)}%</strong></article>
    </div>

    <div className="table-wrap report-analyzer-table-wrap">
      <table className="data-table report-analyzer-table">
        <thead><tr><th>#</th><th>{t('الشركة / المسار', 'Company / route')}</th><th>{t('إجمالي الطلبات', 'Total requests')}</th><th>{t('القيمة الكلية', 'Total value')}</th><th>{t('معاملات PAID', 'PAID')}</th><th>{t('إجمالي الإيداعات', 'Paid deposits')}</th><th>{t('متوسط الإيداع', 'Average deposit')}</th><th>{t('العمولة المحصلة', 'Collected commission')}</th><th>{t('معدل التحويل', 'Conversion')}</th><th>{t('مستوى الخطر', 'Risk')}</th><th><span className="sr-only">{t('تفاصيل', 'Details')}</span></th></tr></thead>
        <tbody>{filtered.map((row, index) => {
          const open = expanded.includes(row.master)
          return <Fragment key={row.master}>
            <tr className={open ? 'company-row is-open' : 'company-row'}>
              <td><span className="report-row-rank">{index + 1}</span></td>
              <td><button className="company-expand-name" type="button" aria-expanded={open} onClick={() => toggle(row.master)}><Building2 size={17}/><span><strong>{row.master}</strong><small>{row.merchants.length} {t('تاجر', 'merchants')}</small></span></button></td>
              <td className="mono">{numeric(row.count, locale)}</td><td className="mono report-gold">{money(row.amount, 'EGP')}</td><td className="mono positive-text">{numeric(row.paid_count, locale)}</td><td className="mono positive-text">{money(row.paid_amount, 'EGP')}</td><td className="mono">{money(row.average_paid, 'EGP')}</td><td className="mono report-gold">{money(row.commission_collected, 'EGP')}</td>
              <td><ConversionMeter value={row.conversion_rate}/></td><td><RiskBadge level={row.risk_level} t={t}/></td><td><button className="report-row-toggle" type="button" aria-expanded={open} aria-label={open ? t('إخفاء التجار', 'Hide merchants') : t('عرض التجار', 'Show merchants')} onClick={() => toggle(row.master)}>{open ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}</button></td>
            </tr>
            {open && row.merchants.map((merchant) => <tr className="company-child-row" key={`${row.master}-${merchant.merchant}`}><td/><td><MerchantLogo merchant={merchant.merchant}/></td><td className="mono">{numeric(merchant.count, locale)}</td><td className="mono">{money(merchant.amount, 'EGP')}</td><td className="mono positive-text">{numeric(merchant.paid_count, locale)}</td><td className="mono positive-text">{money(merchant.paid_amount, 'EGP')}</td><td className="mono">{money(merchant.average_paid, 'EGP')}</td><td className="mono">{money(merchant.commission_collected, 'EGP')}</td><td><ConversionMeter value={merchant.conversion_rate}/></td><td/><td/></tr>)}
          </Fragment>
        })}</tbody>
        {filtered.length > 0 && <tfoot><tr><td/><td>{t('الإجمالي', 'Total')}</td><td className="mono">{numeric(totals.requests, locale)}</td><td className="mono">{money(totals.value, 'EGP')}</td><td className="mono positive-text">{numeric(totals.paid, locale)}</td><td className="mono positive-text">{money(totals.paidAmount, 'EGP')}</td><td className="mono">{money(totals.paid ? totals.paidAmount / totals.paid : 0, 'EGP')}</td><td className="mono">{money(totals.commission, 'EGP')}</td><td><ConversionMeter value={conversion}/></td><td/><td/></tr></tfoot>}
      </table>
      {filtered.length === 0 && <div className="report-analyzer-empty"><Building2 size={24}/><strong>{t('لا توجد شركات مطابقة', 'No matching companies')}</strong><span>{t('غيّر البحث أو نطاق التقرير.', 'Change the search or report scope.')}</span></div>}
    </div>
  </section>
}

export function ReceiverSummaryReport({ rows, locale, t }: SharedProps & { rows: ReceiverReportRow[] }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const needle = query.replace(/\s/g, '').toLowerCase()
    return rows.filter((row) => !needle || [row.receiver, ...row.merchants, ...row.methods].some((value) => value.replace(/\s/g, '').toLowerCase().includes(needle)))
  }, [query, rows])
  const total = useMemo(() => filtered.reduce((sum, row) => ({ count: sum.count + row.count, amount: sum.amount + row.amount }), { count: 0, amount: 0 }), [filtered])

  return <section className="report-analyzer" aria-labelledby="receiver-report-title">
    <div className="report-analyzer-head receiver-head">
      <div><span className="reports-eyebrow"><WalletCards size={14}/>{t('أرقام الاستقبال', 'RECEIVING ACCOUNTS')}</span><h3 id="receiver-report-title">{t('إجمالي المبالغ المستلمة — معاملات PAID فقط', 'Total received amounts — PAID only')}</h3><p>{t('ابحث برقم المحفظة أو الحساب أو اسم التاجر.', 'Search by wallet, account, or merchant name.')}</p></div>
      <label className="report-analyzer-search"><Search size={16}/><span className="sr-only">{t('بحث في أرقام الاستقبال', 'Search receiving accounts')}</span><input inputMode="numeric" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('أدخل رقم المحفظة أو الحساب…', 'Enter wallet or account number…')}/></label>
    </div>
    <div className="report-analyzer-kpis receiver-kpis"><article><small>{t('أرقام الاستقبال', 'Receiving accounts')}</small><strong>{filtered.length.toLocaleString(locale)}</strong></article><article><small>{t('عدد الإيداعات', 'Paid deposits')}</small><strong>{numeric(total.count, locale)}</strong></article><article><small>{t('إجمالي المستلم', 'Total received')}</small><strong className="positive-text">{money(total.amount, 'EGP')}</strong></article><article><small>{t('متوسط الإيداع', 'Average deposit')}</small><strong>{money(total.count ? total.amount / total.count : 0, 'EGP')}</strong></article></div>
    <div className="table-wrap report-analyzer-table-wrap"><table className="data-table report-analyzer-table receiver-table"><thead><tr><th>#</th><th>{t('رقم المحفظة / الحساب', 'Wallet / account')}</th><th>{t('عدد الإيداعات', 'Deposits')}</th><th>{t('إجمالي المستلم', 'Total received')}</th><th>{t('متوسط الإيداع', 'Average deposit')}</th><th>{t('الحصة من الإجمالي', 'Portfolio share')}</th><th>{t('التقييم', 'Rating')}</th><th>{t('التجار / القنوات', 'Merchants / channels')}</th></tr></thead><tbody>{filtered.map((row, index) => <tr key={row.receiver}><td><span className="report-row-rank">{index + 1}</span></td><td className="mono receiver-number"><WalletCards size={15}/>{row.receiver}</td><td className="mono">{numeric(row.count, locale)}</td><td className="mono positive-text">{money(row.amount, 'EGP')}</td><td className="mono">{money(row.average_paid, 'EGP')}</td><td><ConversionMeter value={row.share}/></td><td><Rating value={row.share}/></td><td><div className="receiver-tags">{[...new Set([...row.merchants, ...row.methods])].slice(0, 3).map((value) => <span key={value}>{value}</span>)}</div></td></tr>)}</tbody>{filtered.length > 0 && <tfoot><tr><td/><td>{t('الإجمالي', 'Total')}</td><td className="mono">{numeric(total.count, locale)}</td><td className="mono positive-text">{money(total.amount, 'EGP')}</td><td className="mono">{money(total.count ? total.amount / total.count : 0, 'EGP')}</td><td><ConversionMeter value={100}/></td><td/><td/></tr></tfoot>}</table>{filtered.length === 0 && <div className="report-analyzer-empty"><WalletCards size={24}/><strong>{t('لا توجد أرقام مطابقة', 'No matching receiving accounts')}</strong><span>{t('غيّر البحث أو نطاق التقرير.', 'Change the search or report scope.')}</span></div>}</div>
  </section>
}

export function PaymentRailSummaryReport({ rows, locale, t }: SharedProps & { rows: PaymentRailReportRow[] }) {
  const live = rows.filter((row) => row.active)
  const totals = live.reduce((sum, row) => ({ attempts: sum.attempts + row.count, paid: sum.paid + row.paid_count, amount: sum.amount + row.paid_amount }), { attempts: 0, paid: 0, amount: 0 })
  return <section className="report-analyzer" aria-labelledby="rail-report-title">
    <div className="report-analyzer-head"><div><span className="reports-eyebrow"><Activity size={14}/>{t('تحليل قنوات الدفع', 'PAYMENT RAIL ANALYSIS')}</span><h3 id="rail-report-title">{t('أداء المحافظ وطرق الدفع', 'Wallet and payment-method performance')}</h3><p>{t('القنوات الجديدة جاهزة للتصنيف والتقرير؛ الربط التنفيذي ينتظر بيانات اعتماد المزوّد.', 'New rails are reporting-ready; payment execution awaits provider credentials.')}</p></div></div>
    <div className="report-analyzer-kpis receiver-kpis"><article><small>{t('القنوات النشطة', 'Observed rails')}</small><strong>{live.length.toLocaleString(locale)}</strong></article><article><small>{t('إجمالي المحاولات', 'Total attempts')}</small><strong>{numeric(totals.attempts, locale)}</strong></article><article><small>{t('معاملات PAID', 'PAID transactions')}</small><strong className="positive-text">{numeric(totals.paid, locale)}</strong></article><article><small>{t('حجم PAID', 'PAID volume')}</small><strong className="positive-text">{money(totals.amount, 'EGP')}</strong></article></div>
    <div className="payment-rail-grid">{rows.map((row) => <article className={row.active ? 'payment-rail-card is-live' : 'payment-rail-card'} key={row.key}>
      <header><MethodLogo method={row.label}/><div><strong>{row.label}</strong><small>{row.family}</small></div><span className={row.active ? 'rail-state live' : 'rail-state pending'}>{row.active ? t('بيانات حية', 'Live data') : t('بانتظار الربط', 'Integration pending')}</span></header>
      <dl><div><dt>{t('المحاولات', 'Attempts')}</dt><dd>{numeric(row.count, locale)}</dd></div><div><dt>PAID</dt><dd className="positive-text">{numeric(row.paid_count, locale)}</dd></div><div><dt>{t('الحجم', 'Volume')}</dt><dd>{money(row.paid_amount, 'EGP')}</dd></div><div><dt>{t('المتوسط', 'Average')}</dt><dd>{money(row.average_paid, 'EGP')}</dd></div></dl>
      {row.active ? <ConversionMeter value={row.success_rate}/> : <p className="rail-integration-note"><PlugZap size={14}/>{t('أضف API/Webhook credentials لبدء التنفيذ المباشر.', 'Add API/webhook credentials to enable execution.')}</p>}
    </article>)}</div>
  </section>
}

function ConversionMeter({ value }: { value: number }) {
  return <div className="report-meter-cell"><div className="report-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }}/></div><span className="mono">{value.toFixed(1)}%</span></div>
}

function RiskBadge({ level, t }: { level: CompanyReportRow['risk_level']; t: SharedProps['t'] }) {
  return <span className={`report-risk ${level}`}>{level === 'low' ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>} {level === 'low' ? t('منخفض', 'Low') : level === 'medium' ? t('متوسط', 'Medium') : t('مرتفع', 'High')}</span>
}

function Rating({ value }: { value: number }) {
  const stars = value >= 15 ? 3 : value >= 5 ? 2 : 1
  return <span className="report-rating" aria-label={`${stars} of 3`}>{[1, 2, 3].map((star) => <Star key={star} size={15} fill={star <= stars ? 'currentColor' : 'none'} opacity={star <= stars ? 1 : .25}/>)}</span>
}
