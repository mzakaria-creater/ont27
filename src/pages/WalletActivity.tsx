import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, WalletCards } from 'lucide-react'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Row { wallet: string | null; in_count: number; in_amount: number; out_count: number; out_amount: number; net_amount: number }
interface Totals { in_count: number; in_amount: number; out_count: number; out_amount: number; net_amount: number }
interface ActivityResponse { mode: string; wallet: string | null; wallets: Row[]; totals: Totals }
type Mode = 'day' | 'month' | 'range'

const todayStr = () => new Date().toISOString().slice(0, 10)

export default function WalletActivity() {
  const { t } = useLocale()
  const [mode, setMode] = useState<Mode>('day')
  const [date, setDate] = useState(todayStr())
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [from, setFrom] = useState(todayStr())
  const [to, setTo] = useState(todayStr())
  const [wallet, setWallet] = useState('')
  const [data, setData] = useState<ActivityResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    const params = new URLSearchParams({ mode })
    if (wallet.trim()) params.set('wallet', wallet.trim())
    if (mode === 'day') params.set('date', date)
    else if (mode === 'month') { params.set('year', String(year)); params.set('month', String(month)) }
    else { params.set('from', from); params.set('to', to) }
    api<ActivityResponse>(`/api/reports/wallet-activity?${params.toString()}`)
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : t('تعذر تحميل التقرير', 'Could not load the report')))
      .finally(() => setLoading(false))
  }, [mode, date, year, month, from, to, wallet, t])

  useEffect(() => { load() }, [load])

  return <div className="page-content">
    <section className="page-head">
      <h2><WalletCards size={22} /> {t('نشاط المحافظ الزمني', 'Wallet activity by period')}</h2>
      <p className="page-sub">{t('تدفق الداخل والخارج لكل محفظة حسب يوم أو شهر أو فترة مخصصة.', 'Money in and out per wallet for a day, month, or custom range.')}</p>
    </section>
    <div className="card filter-bar wallet-activity-filters">
      <label>{t('النوع', 'Mode')}<select value={mode} onChange={(e) => setMode(e.target.value as Mode)}><option value="day">{t('يوم', 'Day')}</option><option value="month">{t('شهر', 'Month')}</option><option value="range">{t('فترة', 'Range')}</option></select></label>
      {mode === 'day' && <label>{t('التاريخ', 'Date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
      {mode === 'month' && <><label>{t('السنة', 'Year')}<input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 95 }} /></label><label>{t('الشهر', 'Month')}<select value={month} onChange={(e) => setMonth(Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}</option>)}</select></label></>}
      {mode === 'range' && <><label>{t('من', 'From')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>{t('إلى', 'To')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></>}
      <label>{t('المحفظة (اختياري)', 'Wallet (optional)')}<input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder={t('كل المحافظ', 'All wallets')} /></label>
      <button className="btn-primary btn-sm" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} />{loading ? t('جاري التحميل…', 'Loading…') : t('تحديث التقرير', 'Refresh report')}</button>
    </div>
    {err && <div className="card warn">{err}</div>}
    {data && <>
      <div className="kpi-grid wallet-activity-kpis">
        <div className="kpi-card"><div className="kpi-label">{t('إجمالي الداخل', 'Total in')}</div><div className="kpi-value positive-text">{money(data.totals.in_amount, 'EGP')}</div><div className="cell-sub">{data.totals.in_count} {t('حركة', 'transactions')}</div></div>
        <div className="kpi-card"><div className="kpi-label">{t('إجمالي الخارج', 'Total out')}</div><div className="kpi-value negative-text">{money(data.totals.out_amount, 'EGP')}</div><div className="cell-sub">{data.totals.out_count} {t('حركة', 'transactions')}</div></div>
        <div className="kpi-card"><div className="kpi-label">{t('الصافي التشغيلي', 'Operating net')}</div><div className="kpi-value">{money(data.totals.net_amount, 'EGP')}</div><div className="cell-sub">{t('داخل ناقص خارج', 'In less out')}</div></div>
      </div>
      <section className="card recent-card"><div className="recent-head"><h3>{t('الحركة حسب المحفظة', 'Activity by wallet')}</h3><span className="cell-sub">{data.wallets.length} {t('محفظة', 'wallets')}</span></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المحفظة', 'Wallet')}</th><th>{t('عدد الداخل', 'In count')}</th><th>{t('إجمالي الداخل', 'In amount')}</th><th>{t('عدد الخارج', 'Out count')}</th><th>{t('إجمالي الخارج', 'Out amount')}</th><th>{t('الصافي', 'Net')}</th></tr></thead><tbody>{data.wallets.map((row) => <tr key={row.wallet ?? 'unmapped'}><td className="mono">{row.wallet ?? t('غير محدد', 'Unmapped')}</td><td>{row.in_count}</td><td className="mono positive-text">{money(row.in_amount, 'EGP')}</td><td>{row.out_count}</td><td className="mono negative-text">{money(row.out_amount, 'EGP')}</td><td className="mono">{money(row.net_amount, 'EGP')}</td></tr>)}{data.wallets.length === 0 && <tr><td colSpan={6} className="executive-empty">{t('لا توجد بيانات', 'No data')}</td></tr>}</tbody></table></div></section>
    </>}
  </div>
}
