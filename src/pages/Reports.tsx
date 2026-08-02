import { useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'

// Reports — daily volumes with inline CSS bars.

interface DayRow { date: string; depCount: number; depVolume: number; declined: number; payVolume: number }

export default function Reports() {
  const [days, setDays] = useState(14)
  const [rows, setRows] = useState<DayRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setRows(null)
    api<{ rows: DayRow[] }>(`/api/reports?days=${days}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض التقارير.' : 'تعذّر تحميل التقارير.'))
  }, [days])

  const maxVolume = Math.max(...(rows ?? []).map((r) => r.depVolume), 1)
  const totals = (rows ?? []).reduce(
    (t, r) => ({ dep: t.dep + r.depVolume, count: t.count + r.depCount, declined: t.declined + r.declined, pay: t.pay + r.payVolume }),
    { dep: 0, count: 0, declined: 0, pay: 0 },
  )

  return (
    <PanelShell>
      <section className="page-head">
        <h2>📊 التقارير والتحليلات</h2>
        <p className="page-sub">الأحجام اليومية من المعاملات الحقيقية</p>
      </section>

      <div className="filter-bar">
        <div className="filter-pills">
          {[7, 14, 30].map((d) => (
            <button key={d} className={`pill${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>آخر {d} يوم</button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-icon">💰</span><div className="kpi-value">{rows ? money(totals.dep, '') : '…'}</div><div className="kpi-label">حجم الإيداعات المعتمدة (EGP)</div></div>
        <div className="kpi-card"><span className="kpi-icon">🔢</span><div className="kpi-value">{rows ? totals.count.toLocaleString('en-US') : '…'}</div><div className="kpi-label">عدد الإيداعات المعتمدة</div></div>
        <div className="kpi-card"><span className="kpi-icon">📤</span><div className="kpi-value">{rows ? money(totals.pay, '') : '…'}</div><div className="kpi-label">حجم السحوبات (EGP)</div></div>
        <div className="kpi-card"><span className="kpi-icon">📉</span><div className="kpi-value">{rows ? totals.declined.toLocaleString('en-US') : '…'}</div><div className="kpi-label">إيداعات مرفوضة</div></div>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">جارٍ الحساب…</p>}
        {rows && rows.length === 0 && <p>لا توجد بيانات في الفترة.</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>اليوم</th><th className="bar-col">حجم الإيداعات</th><th>عدد</th><th>مرفوضة</th><th>سحوبات</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date}>
                    <td className="mono">{r.date.slice(5)}</td>
                    <td className="bar-col">
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${Math.max((r.depVolume / maxVolume) * 100, 2)}%` }} />
                        <span className="mono bar-label">{money(r.depVolume, '')}</span>
                      </div>
                    </td>
                    <td className="mono">{r.depCount}</td>
                    <td className="mono" style={{ color: r.declined > 0 ? 'var(--status-declined)' : undefined }}>{r.declined}</td>
                    <td className="mono">{money(r.payVolume, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PanelShell>
  )
}
