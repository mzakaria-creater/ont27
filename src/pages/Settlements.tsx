import { useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'

// Settlements — per-merchant aggregates (approved deposits vs payouts) over a window.

interface SettleRow {
  merchant: string
  master: string | null
  depCount: number
  depVolume: number
  fees: number
  commission: number
  payCount: number
  payVolume: number
}

export default function Settlements() {
  const [days, setDays] = useState(7)
  const [rows, setRows] = useState<SettleRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setRows(null)
    api<{ rows: SettleRow[] }>(`/api/settlements?days=${days}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض التسويات.' : 'تعذّر تحميل التسويات.'))
  }, [days])

  const totals = (rows ?? []).reduce(
    (t, r) => ({
      depVolume: t.depVolume + r.depVolume,
      payVolume: t.payVolume + r.payVolume,
      fees: t.fees + r.fees,
      commission: t.commission + r.commission,
    }),
    { depVolume: 0, payVolume: 0, fees: 0, commission: 0 },
  )

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🧾 التسويات</h2>
        <p className="page-sub">صافي كل تاجر خلال الفترة (إيداعات معتمدة − سحوبات معتمدة) · محسوبة من المعاملات الحقيقية</p>
      </section>

      <div className="filter-bar">
        <div className="filter-pills">
          {[7, 14, 30].map((d) => (
            <button key={d} className={`pill${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
              آخر {d} يوم
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-icon">💰</span>
          <div className="kpi-value">{rows ? money(totals.depVolume, '') : '…'}</div>
          <div className="kpi-label">إجمالي الإيداعات المعتمدة (EGP)</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">📤</span>
          <div className="kpi-value">{rows ? money(totals.payVolume, '') : '…'}</div>
          <div className="kpi-label">إجمالي السحوبات المعتمدة (EGP)</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🧮</span>
          <div className="kpi-value">{rows ? money(totals.depVolume - totals.payVolume, '') : '…'}</div>
          <div className="kpi-label">الصافي (EGP)</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🪙</span>
          <div className="kpi-value">{rows ? money(totals.commission + totals.fees, '') : '…'}</div>
          <div className="kpi-label">عمولات + رسوم (EGP)</div>
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">جارٍ الحساب…</p>}
        {rows && rows.length === 0 && <p>لا توجد معاملات معتمدة في الفترة.</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>التاجر</th>
                  <th>إيداعات</th>
                  <th>حجم الإيداعات</th>
                  <th>سحوبات</th>
                  <th>حجم السحوبات</th>
                  <th>عمولة</th>
                  <th>رسوم</th>
                  <th>الصافي</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.merchant}>
                    <td>{r.merchant}{r.master && <div className="cell-sub">{r.master}</div>}</td>
                    <td className="mono">{r.depCount}</td>
                    <td className="mono">{money(r.depVolume, 'EGP')}</td>
                    <td className="mono">{r.payCount}</td>
                    <td className="mono">{money(r.payVolume, 'EGP')}</td>
                    <td className="mono">{money(r.commission, 'EGP')}</td>
                    <td className="mono">{money(r.fees, 'EGP')}</td>
                    <td className="mono" style={{ color: r.depVolume - r.payVolume >= 0 ? 'var(--status-paid)' : 'var(--status-declined)' }}>
                      {money(r.depVolume - r.payVolume, 'EGP')}
                    </td>
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
