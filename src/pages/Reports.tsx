import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface DayRow { date: string; depCount: number; depVolume: number; declined: number; commission: number; payVolume: number }
interface AggRow { key: string; master: string | null; count: number; volume: number; commission: number; fees: number }
interface Totals { depCount: number; depVolume: number; declined: number; commission: number; fees: number; payCount: number; payVolume: number }
interface Report { from: string | null; to: string | null; totals: Totals; daily: DayRow[]; byMerchant: AggRow[]; byMethod: AggRow[] }

type Tab = 'summary' | 'merchants' | 'methods' | 'daily' | 'settlement'

export default function Reports() {
  const { t } = useLocale()
  // Empty dates intentionally mean all available live data, not a July-only report.
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [merchant, setMerchant] = useState('')
  const [master, setMaster] = useState('')
  const [excludeTest, setExcludeTest] = useState(true)
  const [tab, setTab] = useState<Tab>('summary')
  const [report, setReport] = useState<Report | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [usdRate, setUsdRate] = useState('48')
  const [usdtRate, setUsdtRate] = useState('50')
  const [salaryUsd, setSalaryUsd] = useState('0')
  const [usdtFee, setUsdtFee] = useState('1')
  const [otherEgp, setOtherEgp] = useState('0')
  const [commPct, setCommPct] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setReport(null)
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (merchant) p.set('merchant', merchant)
    if (master) p.set('master', master)
    if (excludeTest) p.set('excludeTest', '1')
    try {
      setReport(await api<Report>(`/api/reports?${p}`))
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية عرض التقارير.', 'You do not have permission to view reports.')
        : t('تعذّر تحميل التقرير.', 'Unable to load the report.'))
    }
  }, [from, to, merchant, master, excludeTest, t])

  useEffect(() => { void load() }, [load])

  const totals = report?.totals
  const merchantNames = useMemo(() => (report?.byMerchant ?? []).map((m) => m.key), [report])
  const maxDaily = Math.max(...(report?.daily ?? []).map((d) => d.depVolume), 1)
  const commOf = (row: AggRow) => {
    const stored = row.commission + row.fees
    return stored > 0 ? stored : (row.volume * Number(commPct[row.key] ?? 0)) / 100
  }
  const totalCommission = (report?.byMerchant ?? []).reduce((sum, row) => sum + commOf(row), 0)
  const dueToMerchants = totals ? totals.depVolume - totalCommission : 0
  const revenue = totalCommission
  const expenses = Number(salaryUsd || 0) * Number(usdRate || 0) + Number(otherEgp || 0)
  const netEgp = revenue - expenses
  const netUsdt = Number(usdtRate) > 0 ? (netEgp / Number(usdtRate)) * (1 - Number(usdtFee || 0) / 100) : 0
  const rangeLabel = report?.from && report?.to
    ? `${report.from} → ${report.to}`
    : t('كل البيانات المتاحة', 'All available data')

  const tabLabels: [Tab, string][] = [
    ['summary', t('📊 الملخص', '📊 Summary')],
    ['merchants', t('🏪 التجار', '🏪 Merchants')],
    ['methods', t('⚡ الطريقة', '⚡ Methods')],
    ['daily', t('📅 اليومية', '📅 Daily')],
    ['settlement', t('💸 التسوية', '💸 Settlement')],
  ]

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('📊 التقارير والتحليلات', '📊 Reports & Analytics')}</h2>
        <p className="page-sub">
          {t('بيانات حية كاملة مع مدى تاريخ وفلاتر', 'Complete live data with optional date range and filters')}
          {report && <> · {rangeLabel} · {t(`${totals?.depCount.toLocaleString('en-US')} معاملة معتمدة`, `${totals?.depCount.toLocaleString('en-US')} approved transactions`)}</>}
        </p>
      </section>

      <div className="filter-bar report-filters">
        <label className="filter-field">{t('من', 'From')} <input type="date" className="login-input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="filter-field">{t('إلى', 'To')} <input type="date" className="login-input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn-ghost btn-sm" onClick={() => { setFrom(''); setTo('') }}>{t('كل الوقت', 'All time')}</button>
        <select className="login-input filter-select" value={merchant} onChange={(e) => setMerchant(e.target.value)}>
          <option value="">{t('كل التجار', 'All merchants')}</option>
          {merchantNames.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <div className="filter-pills">
          <button className={`pill${master === '' ? ' active' : ''}`} onClick={() => setMaster('')}>{t('الكل', 'All')}</button>
          <button className={`pill${master === 'NGPay' ? ' active' : ''}`} onClick={() => setMaster(master === 'NGPay' ? '' : 'NGPay')}>NGPay</button>
          <button className={`pill${master === 'PayFuture' ? ' active' : ''}`} onClick={() => setMaster(master === 'PayFuture' ? '' : 'PayFuture')}>PayFuture</button>
        </div>
        <label className="filter-field check-label">
          <input type="checkbox" checked={excludeTest} onChange={(e) => setExcludeTest(e.target.checked)} /> {t('استثناء Test/NULL', 'Exclude test / empty')}
        </label>
      </div>

      <div className="filter-bar"><div className="filter-pills">
        {tabLabels.map(([key, label]) => <button key={key} className={`pill${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</button>)}
      </div></div>

      {err && <div className="card warn">{err}</div>}
      {!report && !err && <p className="sidebar-hint">{t('جارٍ الحساب…', 'Calculating…')}</p>}

      {report && totals && tab === 'summary' && <>
        <div className="kpi-grid">
          <div className="kpi-card"><span className="kpi-icon">💰</span><div className="kpi-value">{money(totals.depVolume, '')}</div><div className="kpi-label">{t(`إجمالي الإيداعات المعتمدة (ج.م) · ${totals.depCount} عملية`, `Approved deposits (EGP) · ${totals.depCount} transactions`)}</div></div>
          <div className="kpi-card"><span className="kpi-icon">🪙</span><div className="kpi-value">{money(totalCommission, '')}</div><div className="kpi-label">{t('عمولة OnTarget (ج.م)', 'OnTarget commission (EGP)')}</div></div>
          <div className="kpi-card"><span className="kpi-icon">🏪</span><div className="kpi-value">{money(dueToMerchants, '')}</div><div className="kpi-label">{t('مستحق للتجار (ج.م)', 'Due to merchants (EGP)')}</div></div>
          <div className="kpi-card"><span className="kpi-icon">📤</span><div className="kpi-value">{money(totals.payVolume, '')}</div><div className="kpi-label">{t(`سحوبات معتمدة (ج.م) · ${totals.payCount}`, `Approved payouts (EGP) · ${totals.payCount}`)}</div></div>
          <div className="kpi-card"><span className="kpi-icon">📉</span><div className="kpi-value">{totals.declined.toLocaleString('en-US')}</div><div className="kpi-label">{t('مرفوضة', 'Declined')}</div></div>
          <div className="kpi-card"><span className="kpi-icon">🧮</span><div className="kpi-value">{totals.depCount > 0 ? money(totals.depVolume / totals.depCount, '') : '—'}</div><div className="kpi-label">{t('متوسط الصفقة (ج.م)', 'Average transaction (EGP)')}</div></div>
        </div>
        <section className="card recent-card"><div className="recent-head"><h3>{t('حصة كل Master', 'Master share')}</h3></div><div className="table-wrap"><table className="data-table">
          <thead><tr><th>Master</th><th>{t('الحجم', 'Volume')}</th><th>{t('الحصة %', 'Share %')}</th></tr></thead>
          <tbody>{Object.entries(report.byMerchant.reduce<Record<string, number>>((acc, row) => { const key = row.master ?? '—'; acc[key] = (acc[key] ?? 0) + row.volume; return acc }, {})).sort((a, b) => b[1] - a[1]).map(([key, value]) =>
            <tr key={key}><td>{key}</td><td className="mono">{money(value, 'EGP')}</td><td className="mono">{totals.depVolume > 0 ? `${((value / totals.depVolume) * 100).toFixed(1)}%` : '—'}</td></tr>
          )}</tbody>
        </table></div></section>
      </>}

      {report && totals && tab === 'merchants' && <section className="card recent-card"><div className="table-wrap"><table className="data-table">
        <thead><tr><th>{t('التاجر', 'Merchant')}</th><th>{t('عدد', 'Count')}</th><th>{t('الإجمالي (ج.م)', 'Total (EGP)')}</th><th>{t('عمولة OnTarget', 'OnTarget fee')}</th><th>{t('العمولة %', 'Fee %')}</th><th>{t('مستحق للتاجر', 'Due to merchant')}</th><th>{t('الحصة %', 'Share %')}</th></tr></thead>
        <tbody>{report.byMerchant.map((row) => <tr key={row.key}>
          <td>{row.key}{row.master && <div className="cell-sub">{row.master}</div>}</td><td className="mono">{row.count}</td><td className="mono">{money(row.volume, '')}</td><td className="mono">{money(commOf(row), '')}</td>
          <td><input className="login-input control-input mono pct-input" type="number" step="0.1" placeholder="%" value={commPct[row.key] ?? ''} onChange={(e) => setCommPct((previous) => ({ ...previous, [row.key]: e.target.value }))} /></td>
          <td className="mono">{money(row.volume - commOf(row), '')}</td><td className="mono">{totals.depVolume > 0 ? `${((row.volume / totals.depVolume) * 100).toFixed(1)}%` : '—'}</td>
        </tr>)}</tbody>
      </table></div></section>}

      {report && tab === 'methods' && <section className="card recent-card"><div className="table-wrap"><table className="data-table">
        <thead><tr><th>{t('الطريقة', 'Method')}</th><th>Master</th><th>{t('عدد', 'Count')}</th><th>{t('الإجمالي (ج.م)', 'Total (EGP)')}</th><th>{t('العمولة', 'Fee')}</th></tr></thead>
        <tbody>{report.byMethod.map((row) => <tr key={row.key}><td>{row.key.split('||')[0]}</td><td>{row.master ?? '—'}</td><td className="mono">{row.count}</td><td className="mono">{money(row.volume, '')}</td><td className="mono">{money(row.commission + row.fees, '')}</td></tr>)}</tbody>
      </table></div></section>}

      {report && tab === 'daily' && <section className="card recent-card"><div className="table-wrap"><table className="data-table">
        <thead><tr><th>{t('التاريخ', 'Date')}</th><th className="bar-col">{t('حجم الإيداعات', 'Deposit volume')}</th><th>{t('عدد', 'Count')}</th><th>{t('العمولة (ج.م)', 'Fee (EGP)')}</th><th>{t('مرفوضة', 'Declined')}</th><th>{t('سحوبات', 'Payouts')}</th></tr></thead>
        <tbody>{report.daily.map((row) => <tr key={row.date}><td className="mono">{row.date}</td><td className="bar-col"><div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max((row.depVolume / maxDaily) * 100, 2)}%` }} /><span className="mono bar-label">{money(row.depVolume, '')}</span></div></td><td className="mono">{row.depCount}</td><td className="mono">{money(row.commission, '')}</td><td className="mono" style={{ color: row.declined > 0 ? 'var(--status-declined)' : undefined }}>{row.declined}</td><td className="mono">{money(row.payVolume, '')}</td></tr>)}</tbody>
      </table></div></section>}

      {report && totals && tab === 'settlement' && <section className="card recent-card">
        <div className="recent-head"><h3>{t('💸 حاسبة التسوية و P&L', '💸 Settlement & P&L calculator')}</h3></div>
        <div className="control-row" style={{ marginBottom: 12 }}>
          <label className="filter-field">USD/EGP <input className="login-input control-input mono" type="number" value={usdRate} onChange={(e) => setUsdRate(e.target.value)} /></label>
          <label className="filter-field">USDT/EGP <input className="login-input control-input mono" type="number" value={usdtRate} onChange={(e) => setUsdtRate(e.target.value)} /></label>
          <label className="filter-field">{t('راتب الفريق (USD)', 'Team salary (USD)')} <input className="login-input control-input mono" type="number" value={salaryUsd} onChange={(e) => setSalaryUsd(e.target.value)} /></label>
          <label className="filter-field">{t('عمولة USDT %', 'USDT fee %')} <input className="login-input control-input mono" type="number" value={usdtFee} onChange={(e) => setUsdtFee(e.target.value)} /></label>
          <label className="filter-field">{t('مصاريف أخرى (ج.م)', 'Other expenses (EGP)')} <input className="login-input control-input mono" type="number" value={otherEgp} onChange={(e) => setOtherEgp(e.target.value)} /></label>
        </div>
        <div className="kpi-grid">
          <div className="kpi-card"><span className="kpi-icon">💵</span><div className="kpi-value">{money(revenue, '')}</div><div className="kpi-label">{t('إيراد OnTarget', 'OnTarget revenue')}</div></div>
          <div className="kpi-card"><span className="kpi-icon">🧾</span><div className="kpi-value">{money(expenses, '')}</div><div className="kpi-label">{t('المصاريف', 'Expenses')}</div></div>
          <div className="kpi-card" style={{ borderColor: netEgp >= 0 ? 'var(--green-border)' : 'var(--red-border)' }}><span className="kpi-icon">📈</span><div className="kpi-value" style={{ color: netEgp >= 0 ? 'var(--status-paid)' : 'var(--status-declined)' }}>{money(netEgp, '')}</div><div className="kpi-label">{t('صافي الربح (ج.م)', 'Net profit (EGP)')}</div></div>
          <div className="kpi-card"><span className="kpi-icon">🪙</span><div className="kpi-value">{money(netUsdt, '')}</div><div className="kpi-label">{t('صافي USDT بعد العمولة', 'Net USDT after fee')}</div></div>
        </div>
      </section>}
    </PanelShell>
  )
}
