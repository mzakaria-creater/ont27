import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'

// التقارير — generalized from OnTarget_July_Dashboard.html: any date range,
// merchant/master filters, tabs (summary / merchants / methods / daily /
// settlement P&L calculator).

interface DayRow { date: string; depCount: number; depVolume: number; declined: number; commission: number; payVolume: number }
interface AggRow { key: string; master: string | null; count: number; volume: number; commission: number; fees: number }
interface Totals { depCount: number; depVolume: number; declined: number; commission: number; fees: number; payCount: number; payVolume: number }
interface Report { from: string; to: string; totals: Totals; daily: DayRow[]; byMerchant: AggRow[]; byMethod: AggRow[] }

type Tab = 'summary' | 'merchants' | 'methods' | 'daily' | 'settlement'

const iso = (d: Date) => d.toISOString().slice(0, 10)

export default function Reports() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const [merchant, setMerchant] = useState('')
  const [master, setMaster] = useState('')
  const [excludeTest, setExcludeTest] = useState(true)
  const [tab, setTab] = useState<Tab>('summary')
  const [report, setReport] = useState<Report | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // settlement calculator inputs (client-side only)
  const [usdRate, setUsdRate] = useState('48')
  const [usdtRate, setUsdtRate] = useState('50')
  const [salaryUsd, setSalaryUsd] = useState('0')
  const [usdtFee, setUsdtFee] = useState('1')
  const [otherEgp, setOtherEgp] = useState('0')

  const load = useCallback(async () => {
    setReport(null)
    const p = new URLSearchParams({ from, to })
    if (merchant) p.set('merchant', merchant)
    if (master) p.set('master', master)
    if (excludeTest) p.set('excludeTest', '1')
    try {
      setReport(await api<Report>(`/api/reports?${p}`))
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض التقارير.' : 'تعذّر تحميل التقرير.')
    }
  }, [from, to, merchant, master, excludeTest])

  useEffect(() => { void load() }, [load])

  const t = report?.totals
  const merchantNames = useMemo(() => (report?.byMerchant ?? []).map((m) => m.key), [report])
  const maxDaily = Math.max(...(report?.daily ?? []).map((d) => d.depVolume), 1)

  // Per-merchant commission % (editable — the stored commission column is
  // empty in the data, exactly like the July report's editable %).
  const [commPct, setCommPct] = useState<Record<string, string>>({})
  const commOf = (m: AggRow) => {
    const stored = m.commission + m.fees
    if (stored > 0) return stored
    const pct = Number(commPct[m.key] ?? 0)
    return (m.volume * pct) / 100
  }
  const totalCommission = (report?.byMerchant ?? []).reduce((s, m) => s + commOf(m), 0)
  const dueToMerchants = t ? t.depVolume - totalCommission : 0

  // settlement math: OnTarget revenue = commission + fees
  const revenue = totalCommission
  const expenses = Number(salaryUsd || 0) * Number(usdRate || 0) + Number(otherEgp || 0)
  const netEgp = revenue - expenses
  const netUsdt = Number(usdtRate) > 0 ? (netEgp / Number(usdtRate)) * (1 - Number(usdtFee || 0) / 100) : 0

  return (
    <PanelShell>
      <section className="page-head">
        <h2>📊 التقارير والتحليلات</h2>
        <p className="page-sub">
          كل البيانات بمدى تاريخ وفلاتر
          {report && <> · {report.from} ← {report.to} · {t?.depCount.toLocaleString('en-US')} معاملة معتمدة</>}
        </p>
      </section>

      <div className="filter-bar report-filters">
        <label className="filter-field">من <input type="date" className="login-input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="filter-field">إلى <input type="date" className="login-input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select className="login-input filter-select" value={merchant} onChange={(e) => setMerchant(e.target.value)}>
          <option value="">كل التجار</option>
          {merchantNames.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="filter-pills">
          <button className={`pill${master === '' ? ' active' : ''}`} onClick={() => setMaster('')}>الكل</button>
          <button className={`pill${master === 'NGPay' ? ' active' : ''}`} onClick={() => setMaster(master === 'NGPay' ? '' : 'NGPay')}>NGPay</button>
          <button className={`pill${master === 'PayFuture' ? ' active' : ''}`} onClick={() => setMaster(master === 'PayFuture' ? '' : 'PayFuture')}>PayFuture</button>
        </div>
        <label className="filter-field check-label">
          <input type="checkbox" checked={excludeTest} onChange={(e) => setExcludeTest(e.target.checked)} /> استثناء Test/NULL
        </label>
      </div>

      <div className="filter-bar">
        <div className="filter-pills">
          {([['summary', '📊 الملخص'], ['merchants', '🏪 التجار'], ['methods', '⚡ الطريقة'], ['daily', '📅 اليومية'], ['settlement', '💸 التسوية']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} className={`pill${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}
      {!report && !err && <p className="sidebar-hint">جارٍ الحساب…</p>}

      {report && t && tab === 'summary' && (
        <>
          <div className="kpi-grid">
            <div className="kpi-card"><span className="kpi-icon">💰</span><div className="kpi-value">{money(t.depVolume, '')}</div><div className="kpi-label">إجمالي الإيداعات المعتمدة (ج.م) · {t.depCount} عملية</div></div>
            <div className="kpi-card"><span className="kpi-icon">🪙</span><div className="kpi-value">{money(totalCommission, '')}</div><div className="kpi-label">عمولة OnTarget (ج.م) — من نِسَب تبويب التجار</div></div>
            <div className="kpi-card"><span className="kpi-icon">🏪</span><div className="kpi-value">{money(dueToMerchants, '')}</div><div className="kpi-label">مستحق للتجار (ج.م)</div></div>
            <div className="kpi-card"><span className="kpi-icon">📤</span><div className="kpi-value">{money(t.payVolume, '')}</div><div className="kpi-label">سحوبات معتمدة (ج.م) · {t.payCount}</div></div>
            <div className="kpi-card"><span className="kpi-icon">📉</span><div className="kpi-value">{t.declined.toLocaleString('en-US')}</div><div className="kpi-label">مرفوضة</div></div>
            <div className="kpi-card"><span className="kpi-icon">🧮</span><div className="kpi-value">{t.depCount > 0 ? money(t.depVolume / t.depCount, '') : '—'}</div><div className="kpi-label">متوسط الصفقة (ج.م)</div></div>
          </div>
          <section className="card recent-card">
            <div className="recent-head"><h3>حصة كل Master</h3></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Master</th><th>الحجم</th><th>الحصة %</th></tr></thead>
                <tbody>
                  {Object.entries(
                    report.byMerchant.reduce<Record<string, number>>((acc, m) => {
                      const k = m.master ?? '—'
                      acc[k] = (acc[k] ?? 0) + m.volume
                      return acc
                    }, {}),
                  ).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="mono">{money(v, 'EGP')}</td>
                      <td className="mono">{t.depVolume > 0 ? `${((v / t.depVolume) * 100).toFixed(1)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {report && t && tab === 'merchants' && (
        <section className="card recent-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>التاجر</th><th>عدد</th><th>الإجمالي (ج.م)</th><th>عمولة OnTarget</th><th>العمولة %</th><th>مستحق للتاجر</th><th>الحصة %</th></tr></thead>
              <tbody>
                {report.byMerchant.map((m) => (
                  <tr key={m.key}>
                    <td>{m.key}{m.master && <div className="cell-sub">{m.master}</div>}</td>
                    <td className="mono">{m.count}</td>
                    <td className="mono">{money(m.volume, '')}</td>
                    <td className="mono">{money(commOf(m), '')}</td>
                    <td>
                      <input
                        className="login-input control-input mono pct-input"
                        type="number"
                        step="0.1"
                        placeholder="%"
                        value={commPct[m.key] ?? ''}
                        onChange={(e) => setCommPct((p) => ({ ...p, [m.key]: e.target.value }))}
                      />
                    </td>
                    <td className="mono">{money(m.volume - commOf(m), '')}</td>
                    <td className="mono">{t.depVolume > 0 ? `${((m.volume / t.depVolume) * 100).toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report && tab === 'methods' && (
        <section className="card recent-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>الطريقة</th><th>Master</th><th>عدد</th><th>الإجمالي (ج.م)</th><th>عمولة</th></tr></thead>
              <tbody>
                {report.byMethod.map((m) => (
                  <tr key={m.key}>
                    <td>{m.key.split('||')[0]}</td>
                    <td>{m.master ?? '—'}</td>
                    <td className="mono">{m.count}</td>
                    <td className="mono">{money(m.volume, '')}</td>
                    <td className="mono">{money(m.commission + m.fees, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report && tab === 'daily' && (
        <section className="card recent-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>التاريخ</th><th className="bar-col">حجم الإيداعات</th><th>عدد</th><th>العمولة (ج.م)</th><th>مرفوضة</th><th>سحوبات</th></tr></thead>
              <tbody>
                {report.daily.map((r) => (
                  <tr key={r.date}>
                    <td className="mono">{r.date.slice(5)}</td>
                    <td className="bar-col">
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${Math.max((r.depVolume / maxDaily) * 100, 2)}%` }} />
                        <span className="mono bar-label">{money(r.depVolume, '')}</span>
                      </div>
                    </td>
                    <td className="mono">{r.depCount}</td>
                    <td className="mono">{money(r.commission, '')}</td>
                    <td className="mono" style={{ color: r.declined > 0 ? 'var(--status-declined)' : undefined }}>{r.declined}</td>
                    <td className="mono">{money(r.payVolume, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report && t && tab === 'settlement' && (
        <>
          <section className="card recent-card">
            <div className="recent-head"><h3>💸 حاسبة التسوية و P&L (على الفترة المفلترة)</h3></div>
            <div className="control-row" style={{ marginBottom: 12 }}>
              <label className="filter-field">USD/EGP <input className="login-input control-input mono" type="number" value={usdRate} onChange={(e) => setUsdRate(e.target.value)} /></label>
              <label className="filter-field">USDT/EGP <input className="login-input control-input mono" type="number" value={usdtRate} onChange={(e) => setUsdtRate(e.target.value)} /></label>
              <label className="filter-field">راتب الفريق (USD) <input className="login-input control-input mono" type="number" value={salaryUsd} onChange={(e) => setSalaryUsd(e.target.value)} /></label>
              <label className="filter-field">عمولة USDT % <input className="login-input control-input mono" type="number" value={usdtFee} onChange={(e) => setUsdtFee(e.target.value)} /></label>
              <label className="filter-field">مصاريف أخرى (ج.م) <input className="login-input control-input mono" type="number" value={otherEgp} onChange={(e) => setOtherEgp(e.target.value)} /></label>
            </div>
            <div className="kpi-grid">
              <div className="kpi-card"><span className="kpi-icon">💵</span><div className="kpi-value">{money(revenue, '')}</div><div className="kpi-label">إيراد OnTarget (عمولة + رسوم)</div></div>
              <div className="kpi-card"><span className="kpi-icon">🧾</span><div className="kpi-value">{money(expenses, '')}</div><div className="kpi-label">المصاريف (رواتب + أخرى)</div></div>
              <div className="kpi-card" style={{ borderColor: netEgp >= 0 ? 'var(--green-border)' : 'var(--red-border)' }}>
                <span className="kpi-icon">📈</span>
                <div className="kpi-value" style={{ color: netEgp >= 0 ? 'var(--status-paid)' : 'var(--status-declined)' }}>{money(netEgp, '')}</div>
                <div className="kpi-label">صافي الربح (ج.م)</div>
              </div>
              <div className="kpi-card"><span className="kpi-icon">🪙</span><div className="kpi-value">{money(netUsdt, '')}</div><div className="kpi-label">صافي USDT بعد العمولة</div></div>
            </div>
          </section>
        </>
      )}
    </PanelShell>
  )
}
