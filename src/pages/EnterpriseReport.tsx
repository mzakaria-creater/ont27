import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, CalendarDays, Download, Printer, RefreshCw, TrendingDown, TrendingUp, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Bucket = { count: number; amount: number }
type Report = {
  live: { paidVolume: number; paidCount: number; successRate: number; declinedCount: number; outgoingAmount: number; outgoingCount: number; activeWallets: number; matchedSms: number; smsCoverage: number; updatedAt: string }
  depositStatuses: Record<string, Bucket>
  payoutStatuses: Record<string, Bucket>
  daily: { date: string; deposits: number; payouts: number; count: number }[]
  byMaster: { master: string; count: number; amount: number; paid_amount?: number }[]
  byReceiver: { receiver: string; count: number; amount: number }[]
}
type Wallet = { wallet: string; device: string | null; sms_count: number; deposits_amount: number | null; withdrawals_amount: number | null; balance: number | null; unconfirmed: number }

const dateValue = (value: Date) => value.toISOString().slice(0, 10)
const monthStart = () => dateValue(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

export default function EnterpriseReport() {
  const { t, locale } = useLocale()
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(() => dateValue(new Date()))
  const [report, setReport] = useState<Report | null>(null)
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ from, to })
      const [next, walletData] = await Promise.all([
        api<Report>(`/api/reports?${query}`),
        api<{ rows: Wallet[] }>(`/api/wallet-report?${query}&days=31`),
      ])
      setReport(next)
      setWallets(walletData.rows ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية عرض التقرير.', 'You do not have permission to view this report.')
        : t('تعذّر تحميل التقرير المالي.', 'Unable to load the financial report.'))
    } finally { setLoading(false) }
  }, [from, to, t])

  useEffect(() => { void load() }, [load])

  const totals = useMemo(() => {
    const deposits = report?.depositStatuses ?? {}
    const payouts = report?.payoutStatuses ?? {}
    const incoming = Number(deposits.PAID?.amount ?? 0) + Number(deposits.APPROVED?.amount ?? 0)
    const outgoing = Number(payouts.PAID?.amount ?? 0) + Number(payouts.APPROVED?.amount ?? 0)
    return { incoming, outgoing, net: incoming - outgoing, pending: Number(deposits.PENDING?.amount ?? 0), declined: Number(deposits.DECLINED?.amount ?? 0) }
  }, [report])
  const maxDaily = Math.max(1, ...(report?.daily ?? []).map((row) => Math.max(row.deposits, row.payouts)))
  const exportReport = () => { window.location.assign(`/api/reports/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`) }

  return <PanelShell>
    <section className="page-head reports-page-head">
      <div><span className="reports-eyebrow"><BarChart3 size={14} /> ONTARGET · FINANCIAL CONTROL</span><h2>{t('تقرير الميزان المالي', 'Enterprise financial report')}</h2><p className="page-sub">{t('ملخص تنفيذي حي للإيداعات، السحوبات، المحافظ وصحة المطابقة.', 'Live executive view of deposits, payouts, wallets, and reconciliation health.')}</p>{report && <span className="cell-sub mono">{t('آخر تحديث', 'Updated')} {new Date(report.live.updatedAt).toLocaleTimeString(locale)}</span>}</div>
      <div className="control-row"><button className="btn-ghost btn-sm" type="button" onClick={() => window.print()}><Printer size={15} /> {t('طباعة', 'Print')}</button><button className="btn-primary btn-sm" type="button" onClick={exportReport}><Download size={15} /> {t('تصدير CSV', 'Export CSV')}</button></div>
    </section>
    <section className="card reports-filter-card"><div className="reports-scope-grid"><label>{t('من', 'From')}<input className="login-input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label><label>{t('إلى', 'To')}<input className="login-input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label><button className="btn-ghost btn-sm" type="button" onClick={() => { setFrom(monthStart()); setTo(dateValue(new Date())) }}>{t('هذا الشهر', 'This month')}</button><button className="btn-primary btn-sm" type="button" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''} /> {loading ? t('جارٍ التحميل…', 'Loading…') : t('تحديث التقرير', 'Refresh report')}</button><span className="reports-range"><CalendarDays size={14} /> {from} — {to}</span></div></section>
    {error && <div className="card warn">{error}</div>}
    {report && <>
      <div className="reports-kpis live-financial-kpis">
        <article><span className="reports-kpi-icon positive"><TrendingUp size={18} /></span><small>{t('الإيداعات المعتمدة', 'Approved inflow')}</small><strong>{money(totals.incoming, 'EGP')}</strong><em>{report.live.paidCount} {t('معاملة مدفوعة', 'paid transactions')}</em></article>
        <article><span className="reports-kpi-icon negative"><TrendingDown size={18} /></span><small>{t('السحوبات المعتمدة', 'Approved outflow')}</small><strong>{money(totals.outgoing, 'EGP')}</strong><em>{report.live.outgoingCount} {t('حركة صادرة', 'outgoing events')}</em></article>
        <article><span className="reports-kpi-icon"><BarChart3 size={18} /></span><small>{t('صافي الحركة', 'Net movement')}</small><strong className={totals.net >= 0 ? 'positive-text' : 'negative-text'}>{money(totals.net, 'EGP')}</strong><em>{report.live.successRate.toFixed(1)}% {t('نسبة النجاح', 'success rate')}</em></article>
        <article><span className="reports-kpi-icon"><WalletCards size={18} /></span><small>{t('المحافظ النشطة', 'Active wallets')}</small><strong>{report.live.activeWallets}</strong><em>{report.live.smsCoverage.toFixed(1)}% {t('تغطية SMS', 'SMS coverage')}</em></article>
      </div>
      <div className="reports-grid">
        <section className="card recent-card reports-span-2"><div className="recent-head"><div><h3>{t('الحركة اليومية', 'Daily movement')}</h3><span className="cell-sub">{t('الإيداعات مقابل السحوبات', 'Deposits versus payouts')}</span></div></div><div className="table-wrap"><table className="data-table reports-table"><thead><tr><th>{t('التاريخ', 'Date')}</th><th>{t('الإيداعات', 'Deposits')}</th><th>{t('السحوبات', 'Payouts')}</th><th>{t('الصافي', 'Net')}</th><th>{t('الحجم', 'Volume')}</th></tr></thead><tbody>{report.daily.map((row) => <tr key={row.date}><td className="mono">{row.date}</td><td className="mono positive-text">{money(row.deposits, 'EGP')}</td><td className="mono negative-text">{money(row.payouts, 'EGP')}</td><td className="mono">{money(row.deposits - row.payouts, 'EGP')}</td><td><div className="reports-mini-bars"><i style={{ width: `${row.deposits / maxDaily * 100}%` }} /><i className="out" style={{ width: `${row.payouts / maxDaily * 100}%` }} /></div></td></tr>)}</tbody></table></div></section>
        <StatusCard title={t('حالة الإيداعات', 'Deposit status')} rows={report.depositStatuses} />
        <StatusCard title={t('حالة السحوبات', 'Payout status')} rows={report.payoutStatuses} />
        <Breakdown title={t('حسب الشركة / التاجر الرئيسي', 'By master merchant')} rows={report.byMaster.map((row) => ({ name: row.master, count: row.count, amount: row.amount }))} />
        <Breakdown title={t('حسب المحفظة المستقبلة', 'By receiving wallet')} rows={report.byReceiver.map((row) => ({ name: row.receiver, count: row.count, amount: row.amount }))} />
      </div>
      <section className="card recent-card"><div className="recent-head"><div><h3>{t('تقرير المحافظ والسيولة', 'Wallet liquidity report')}</h3><span className="cell-sub">{wallets.length} {t('محفظة ضمن النطاق', 'wallets in range')}</span></div></div><div className="table-wrap"><table className="data-table reports-table"><thead><tr><th>{t('المحفظة', 'Wallet')}</th><th>{t('الجهاز', 'Device')}</th><th>{t('SMS', 'SMS')}</th><th>{t('الإيداعات', 'Deposits')}</th><th>{t('السحوبات', 'Payouts')}</th><th>{t('الرصيد', 'Balance')}</th><th>{t('غير مؤكدة', 'Unconfirmed')}</th></tr></thead><tbody>{wallets.map((row) => <tr key={row.wallet}><td className="mono">{row.wallet}</td><td>{row.device ?? '—'}</td><td className="mono">{row.sms_count}</td><td className="mono positive-text">{money(row.deposits_amount, 'EGP')}</td><td className="mono negative-text">{money(row.withdrawals_amount, 'EGP')}</td><td className="mono">{money(row.balance, 'EGP')}</td><td className="mono">{row.unconfirmed}</td></tr>)}</tbody></table></div></section>
    </>}
  </PanelShell>
}

function StatusCard({ title, rows }: { title: string; rows: Record<string, Bucket> }) {
  return <section className="card recent-card"><div className="recent-head"><h3>{title}</h3></div><div className="reports-breakdown">{Object.entries(rows).map(([status, row]) => <div key={status}><div><strong>{status}</strong><span>{row.count} · {money(row.amount, 'EGP')}</span></div><div className="bar-track"><i className="bar-fill" style={{ width: `${Math.min(100, row.amount ? 100 : 0)}%` }} /></div></div>)}</div></section>
}

function Breakdown({ title, rows }: { title: string; rows: { name: string; count: number; amount: number }[] }) {
  const total = rows.reduce((sum, row) => sum + row.amount, 0)
  return <section className="card recent-card"><div className="recent-head"><h3>{title}</h3></div><div className="reports-breakdown">{rows.slice(0, 12).map((row) => <div key={row.name}><div><strong>{row.name || '—'}</strong><span>{row.count} · {money(row.amount, 'EGP')}</span></div><div className="bar-track"><i className="bar-fill" style={{ width: `${total ? Math.min(100, row.amount / total * 100) : 0}%` }} /></div></div>)}</div></section>
}
