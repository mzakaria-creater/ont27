import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, BarChart3, CalendarDays, CheckCircle2, CircleDollarSign, Clock3, RefreshCw, ShieldCheck, TrendingUp, Users, WalletCards, XCircle } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Bucket = { count: number; amount: number }
type Report = {
  from: string | null
  to: string | null
  live: { updatedAt: string; paidVolume: number; paidCount: number; successRate: number; linkedPaid: number; declinedCount: number; activeWallets: number; smsCoverage: number; matchedSms: number; outgoingAmount: number; outgoingCount: number; recent: Array<{ tx_id: number; ontarget_ref: string | null; amount: number | null; status: string | null; merchant: string | null; payment_method: string | null; receiving_wallet: string | null; first_seen_at: string | null; sms_linked: boolean }> }
  hero: { ngpayPaid: number; approvedPayouts: number; net: number }
  depositStatuses: Record<string, Bucket>
  payoutStatuses: Record<string, Bucket>
  byMaster: Array<{ master: string; count: number; amount: number }>
  byMethod: Array<{ method: string; master: string; count: number; amount: number }>
  daily: Array<{ date: string; deposits: number; payouts: number; count: number }>
  unassigned: { count: number; amount: number }
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10)
const monthStart = () => { const d = new Date(); return isoDate(new Date(d.getFullYear(), d.getMonth(), 1)) }
const statusIcon = (status: string) => status === 'PAID' || status === 'APPROVED' ? CheckCircle2 : status === 'DECLINED' ? XCircle : status === 'PENDING' ? Clock3 : AlertTriangle

export default function MZReport() {
  const { t, locale } = useLocale()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(isoDate(new Date()))
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = new URLSearchParams({ from, to })
      const next = await api<Report>(`/api/reports?${q}`)
      setReport(next); setError(null)
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التقرير.', 'You do not have permission to view this report.') : t('تعذر تحميل التقرير الحي.', 'Unable to load the live report.'))
    } finally { setLoading(false) }
  }, [from, to, t])

  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(id) }, [load])

  const totalVolume = report?.live.paidVolume ?? 0
  const maxDaily = useMemo(() => Math.max(1, ...(report?.daily ?? []).flatMap((d) => [d.deposits, d.payouts])), [report])
  const statuses = useMemo(() => Object.entries(report?.depositStatuses ?? {}).sort((a, b) => b[1].amount - a[1].amount), [report])
  const topMerchants = useMemo(() => (report?.byMaster ?? []).slice().sort((a, b) => b.amount - a.amount).slice(0, 8), [report])
  const topMethods = useMemo(() => (report?.byMethod ?? []).slice().sort((a, b) => b.amount - a.amount).slice(0, 8), [report])
  const paid = report?.depositStatuses?.PAID?.count ?? 0
  const declined = report?.depositStatuses?.DECLINED?.count ?? 0
  const pending = report?.depositStatuses?.PENDING?.count ?? 0
  const riskCount = declined + pending + (report?.unassigned.count ?? 0)
  const averagePaidTicket = report?.live.paidCount ? totalVolume / report.live.paidCount : 0
  const reconciliationGap = Math.max(0, (report?.live.paidCount ?? 0) - (report?.live.linkedPaid ?? 0))

  return <main className="mz-report-page" dir="rtl">
    <header className="mz-report-hero">
      <div><span className="mz-eyebrow"><ShieldCheck size={14}/> MZ REPORT · LIVE FINANCE INTELLIGENCE</span><h1>{t('تقرير MZ التنفيذي', 'MZ Executive Report')}</h1><p>{t('تحليل حي للمدير التنفيذي والمدير المالي والمحاسب من بيانات المعاملات الفعلية.', 'Live CEO, CFO and accounting analysis from the actual transaction ledger.')}</p></div>
      <div className="mz-report-actions"><label><CalendarDays size={14}/><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><span>—</span><label><CalendarDays size={14}/><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><button className="btn-primary btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'mz-spin' : ''}/>{t('تحديث حي', 'Refresh live')}</button></div>
    </header>
    {error && <div className="card warn">{error}</div>}
    {!report && loading && <div className="card mz-empty">{t('جارٍ تحميل البيانات الحية…', 'Loading live data…')}</div>}
    {report && <>
      <section className="mz-kpi-grid">
        <article className="mz-kpi gold"><span><CircleDollarSign size={16}/>{t('حجم المدفوعات PAID', 'Paid payment volume')}</span><strong>{money(totalVolume, 'EGP')}</strong><small>{report.live.paidCount} {t('معاملة مؤكدة', 'confirmed transactions')}</small></article>
        <article className="mz-kpi green"><span><TrendingUp size={16}/>{t('صافي التسوية', 'Net settlement')}</span><strong>{money(report.hero.net, 'EGP')}</strong><small>{t('إيداعات مدفوعة ناقص السحوبات المعتمدة', 'Paid deposits less approved payouts')}</small></article>
        <article className="mz-kpi blue"><span><Activity size={16}/>{t('معدل النجاح', 'Success rate')}</span><strong>{Number(report.live.successRate ?? 0).toFixed(1)}%</strong><small>{paid} PAID · {declined} {t('مرفوض', 'declined')}</small></article>
        <article className={`mz-kpi ${riskCount ? 'red' : 'green'}`}><span><AlertTriangle size={16}/>{t('نقاط تحتاج قرارًا', 'Decision points')}</span><strong>{riskCount}</strong><small>{pending} {t('معلقة', 'pending')} · {report.unassigned.count} {t('غير مصنفة', 'unassigned')}</small></article>
        <article className="mz-kpi purple"><span><WalletCards size={16}/>{t('تغطية ربط SMS', 'SMS link coverage')}</span><strong>{Number(report.live.smsCoverage ?? 0).toFixed(1)}%</strong><small>{report.live.matchedSms} {t('مطابقة', 'matched')}</small></article>
        <article className="mz-kpi slate"><span><Users size={16}/>{t('المحافظ النشطة', 'Active wallets')}</span><strong>{report.live.activeWallets}</strong><small>{t('من نطاق التقرير', 'in selected range')}</small></article>
      </section>

      <section className="mz-insight-grid">
        <article className="card mz-insight-card revenue"><div className="mz-insight-icon">💹</div><div><small>{t('أداء الإيراد', 'Revenue performance')}</small><strong>{money(totalVolume, 'EGP')}</strong><span>{t('حجم المدفوعات المؤكدة', 'Confirmed paid volume')}</span></div><b>{averagePaidTicket ? `${money(averagePaidTicket, 'EGP')} ${t('متوسط التذكرة', 'avg ticket')}` : '—'}</b></article>
        <article className="card mz-insight-card health"><div className="mz-insight-icon">🩺</div><div><small>{t('صحة المعاملات', 'Transaction health')}</small><strong>{Number(report.live.successRate ?? 0).toFixed(1)}%</strong><span>{paid} {t('ناجحة', 'successful')} · {pending} {t('معلقة', 'pending')}</span></div><b>{declined} {t('مرفوضة', 'declined')}</b></article>
        <article className="card mz-insight-card coverage"><div className="mz-insight-icon">📡</div><div><small>{t('تغطية المحافظ', 'Wallet coverage')}</small><strong>{report.live.activeWallets}</strong><span>{t('محافظ نشطة في النطاق', 'active wallets in range')}</span></div><b>{Number(report.live.smsCoverage ?? 0).toFixed(1)}% SMS</b></article>
        <article className="card mz-insight-card reconcile"><div className="mz-insight-icon">🧾</div><div><small>{t('المطابقة', 'Reconciliation')}</small><strong>{reconciliationGap}</strong><span>{t('مدفوعة بلا ربط SMS', 'paid without SMS link')}</span></div><b>{report.unassigned.count} {t('غير مصنفة', 'unassigned')}</b></article>
      </section>

      <section className="mz-report-grid">
        <article className="card mz-panel mz-wide"><div className="mz-panel-head"><div><h2><BarChart3 size={18}/>{t('الحركة اليومية', 'Daily movement')}</h2><small>{t('إيداعات مقابل سحوبات — قراءة CFO', 'Deposits versus payouts — CFO view')}</small></div><span className="mz-live"><i/>LIVE</span></div><div className="mz-bars">{report.daily.length ? report.daily.slice(-14).map((d) => <div className="mz-bar-day" key={d.date}><div className="mz-bars-stack"><i className="in" style={{ height: `${Math.max(3, d.deposits / maxDaily * 150)}px` }} title={money(d.deposits, 'EGP')}/><i className="out" style={{ height: `${Math.max(3, d.payouts / maxDaily * 150)}px` }} title={money(d.payouts, 'EGP')}/></div><b>{d.date.slice(5)}</b></div>) : <div className="mz-empty">{t('لا توجد حركة في النطاق.', 'No movement in this range.')}</div>}</div><div className="mz-legend"><span><i className="in"/>{t('إيداعات','Deposits')}</span><span><i className="out"/>{t('سحوبات','Payouts')}</span></div></article>
        <article className="card mz-panel"><div className="mz-panel-head"><div><h2><ShieldCheck size={18}/>{t('حالات الإيداع', 'Deposit status')}</h2><small>{t('منظور محاسبي للمخاطر', 'Accounting risk view')}</small></div></div><div className="mz-status-list">{statuses.map(([status, row]) => { const Icon = statusIcon(status); return <div className="mz-status-row" key={status}><span className={`mz-status-icon ${status.toLowerCase()}`}><Icon size={16}/></span><span>{status}</span><b>{row.count}</b><em>{money(row.amount, 'EGP')}</em></div> })}</div></article>
      </section>

      <section className="card mz-panel mz-ceo-strip">
        <div className="mz-panel-head"><div><h2>🎯 {t('قراءة CEO / CFO / Accounting', 'CEO / CFO / Accounting readout')}</h2><small>{t('ملخص قرار سريع مبني على نفس البيانات الحية.', 'Fast decision summary based on the same live ledger.')}</small></div></div>
        <div className="mz-readout-grid">
          <div><span>🚀 {t('فرصة النمو', 'Growth signal')}</span><p>{topMerchants[0] ? `${topMerchants[0].master} · ${money(topMerchants[0].amount, 'EGP')}` : t('لا توجد بيانات كافية', 'Not enough data')}</p></div>
          <div><span>⚠️ {t('أولوية المخاطر', 'Risk priority')}</span><p>{riskCount ? `${pending} ${t('معلقة +', 'pending +')} ${report.unassigned.count} ${t('غير مصنفة', 'unassigned')}` : t('لا توجد نقاط حرجة', 'No critical points')}</p></div>
          <div><span>✅ {t('قرار المطابقة', 'Reconciliation decision')}</span><p>{reconciliationGap ? t('مراجعة المدفوعات غير المرتبطة قبل الإقفال.', 'Review unlinked paid transactions before close.') : t('التغطية مكتملة ضمن النطاق.', 'Coverage is complete in this range.')}</p></div>
        </div>
      </section>

      <section className="mz-report-grid">
        <article className="card mz-panel"><div className="mz-panel-head"><h2><TrendingUp size={18}/>{t('التجار / المسارات الأعلى', 'Top merchants / routes')}</h2></div><div className="mz-rank-list">{topMerchants.map((row, i) => <div key={row.master}><span className="mz-rank">{i + 1}</span><span>{row.master || t('غير محدد','Unassigned')}</span><b>{money(row.amount, 'EGP')}</b><i><u style={{ width: `${totalVolume ? Math.min(100, row.amount / totalVolume * 100) : 0}%` }}/></i></div>)}</div></article>
        <article className="card mz-panel"><div className="mz-panel-head"><h2><CircleDollarSign size={18}/>{t('قنوات الدفع', 'Payment rails')}</h2></div><div className="mz-rank-list">{topMethods.map((row) => <div key={`${row.method}-${row.master}`}><span className="mz-method-dot"/><span>{row.method || t('غير محدد','Unassigned')}</span><b>{money(row.amount, 'EGP')}</b><small>{row.count} TRX</small></div>)}</div></article>
      </section>

      <section className="card mz-panel mz-live-table"><div className="mz-panel-head"><div><h2><Activity size={18}/>{t('آخر المعاملات الحية', 'Latest live transactions')}</h2><small>{report.live.updatedAt ? new Date(report.live.updatedAt).toLocaleString(locale) : '—'}</small></div><a className="btn-ghost btn-sm" href="/transactions">{t('فتح كل المعاملات', 'Open all transactions')}</a></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المعاملة','Transaction')}</th><th>{t('التاجر','Merchant')}</th><th>{t('المحفظة','Wallet')}</th><th>{t('المبلغ','Amount')}</th><th>{t('الحالة','Status')}</th><th>SMS</th><th>{t('الوقت','Time')}</th></tr></thead><tbody>{report.live.recent.slice(0, 12).map((row) => <tr key={row.tx_id}><td className="mono"><a href={`/transactions/${row.ontarget_ref ?? row.tx_id}`}>#{row.ontarget_ref ?? row.tx_id}</a></td><td>{row.merchant ?? '—'}</td><td className="mono">{row.receiving_wallet ?? '—'}</td><td className="mono">{money(row.amount, 'EGP')}</td><td><span className={`status-badge status-${String(row.status ?? '').toLowerCase()}`}>{row.status ?? '—'}</span></td><td><span className={`pay-status-badge ${row.sms_linked ? 'st-paid' : 'st-dim'}`}>{row.sms_linked ? t('مرتبطة','Linked') : t('غير مرتبطة','Unlinked')}</span></td><td className="mono">{row.first_seen_at ? new Date(row.first_seen_at).toLocaleString(locale) : '—'}</td></tr>)}</tbody></table></div></section>
    </>}
  </main>
}
