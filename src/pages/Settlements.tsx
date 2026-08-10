import { useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

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
  const { t } = useLocale()
  const [days, setDays] = useState(7)
  const [rows, setRows] = useState<SettleRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setRows(null)
    api<{ rows: SettleRow[] }>(`/api/settlements?days=${days}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التسويات.', 'You do not have permission to view settlements.') : t('تعذّر تحميل التسويات.', 'Failed to load settlements.')))
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
        <h2>🧾 {t('التسويات', 'Settlements')}</h2>
        <p className="page-sub">{t('صافي كل تاجر خلال الفترة (إيداعات معتمدة − سحوبات معتمدة) · محسوبة من المعاملات الحقيقية', 'Net per merchant over the window (approved deposits − approved payouts) · computed from real transactions')}</p>
      </section>

      <div className="filter-bar">
        <div className="filter-pills">
          {[7, 14, 30].map((d) => (
            <button key={d} className={`pill${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
              {t('آخر', 'Last')} {d} {t('يوم', 'days')}
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-icon">💰</span>
          <div className="kpi-value">{rows ? money(totals.depVolume, '') : '…'}</div>
          <div className="kpi-label">{t('إجمالي الإيداعات المعتمدة (EGP)', 'Total approved deposits (EGP)')}</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">📤</span>
          <div className="kpi-value">{rows ? money(totals.payVolume, '') : '…'}</div>
          <div className="kpi-label">{t('إجمالي السحوبات المعتمدة (EGP)', 'Total approved payouts (EGP)')}</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🧮</span>
          <div className="kpi-value">{rows ? money(totals.depVolume - totals.payVolume, '') : '…'}</div>
          <div className="kpi-label">{t('الصافي (EGP)', 'Net (EGP)')}</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🪙</span>
          <div className="kpi-value">{rows ? money(totals.commission + totals.fees, '') : '…'}</div>
          <div className="kpi-label">{t('عمولات + رسوم (EGP)', 'Commission + fees (EGP)')}</div>
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">{t('جارٍ الحساب…', 'Calculating…')}</p>}
        {rows && rows.length === 0 && <p>{t('لا توجد معاملات معتمدة في الفترة.', 'No approved transactions in this window.')}</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('إيداعات', 'Deposits')}</th>
                  <th>{t('حجم الإيداعات', 'Deposit volume')}</th>
                  <th>{t('سحوبات', 'Payouts')}</th>
                  <th>{t('حجم السحوبات', 'Payout volume')}</th>
                  <th>{t('عمولة', 'Commission')}</th>
                  <th>{t('رسوم', 'Fees')}</th>
                  <th>{t('الصافي', 'Net')}</th>
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
