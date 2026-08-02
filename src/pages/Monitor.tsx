import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money, statusMeta } from '../lib/deposits'
import type { DepositStats } from '../lib/deposits'
import { useLocale } from '../lib/locale'

export default function Monitor() {
  const { t } = useLocale()
  const [stats, setStats] = useState<DepositStats | null>(null)
  const [error, setError] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    try {
      setStats(await api<DepositStats>('/api/deposits/stats'))
      setError(false)
      setUpdatedAt(new Date())
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = setInterval(() => void load(), 20_000)
    return () => clearInterval(interval)
  }, [load])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('📡 المراقبة المباشرة', '📡 Live Monitor')}</h2>
        <p className="page-sub">
          {t('صحة التشغيل، الطابور، وأحدث حركة من البيانات الحية.', 'Operational health, queue status, and recent activity from live data.')}
          {updatedAt && <> · {t('تحديث', 'Updated')} {updatedAt.toLocaleTimeString()}</>}
        </p>
      </section>

      {error && <div className="card warn">{t('تعذّر تحميل بيانات المراقبة.', 'Unable to load live monitor data.')}</div>}

      <div className="stat-grid">
        <Link to="/deposits?status=PENDING" className="stat-card stat-pending">
          <span className="stat-label">{t('إيداعات معلّقة', 'Pending deposits')}</span>
          <span className="stat-value">{stats ? stats.pending : '…'}</span>
          <span className="stat-sub">{t('تحتاج مراجعة الآن', 'Need review now')}</span>
        </Link>
        <div className="stat-card">
          <span className="stat-label">{t('مدفوع · آخر 24 ساعة', 'Paid · last 24 hours')}</span>
          <span className="stat-value">{stats ? money(stats.day.paid.volume, 'EGP') : '…'}</span>
          <span className="stat-sub">{stats ? t(`${stats.day.paid.count} عملية`, `${stats.day.paid.count} transactions`) : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('مدفوع · آخر 7 أيام', 'Paid · last 7 days')}</span>
          <span className="stat-value">{stats ? money(stats.week.paid.volume, 'EGP') : '…'}</span>
          <span className="stat-sub">{stats ? t(`${stats.week.paid.count} عملية`, `${stats.week.paid.count} transactions`) : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('مرفوض · آخر 24 ساعة', 'Declined · last 24 hours')}</span>
          <span className="stat-value">{stats ? stats.day.declined : '…'}</span>
          <span className="stat-sub">{stats ? t(`من إجمالي ${stats.total.toLocaleString('en-US')} إيداع`, `of ${stats.total.toLocaleString('en-US')} total deposits`) : ''}</span>
        </div>
      </div>

      <section className="card recent-card">
        <div className="recent-head">
          <h3>{t('أحدث النشاط', 'Latest activity')}</h3>
          <button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button>
        </div>
        {!stats && !error && <p className="sidebar-hint">{t('جارٍ الاتصال…', 'Connecting…')}</p>}
        {stats && stats.recent.length === 0 && <p>{t('لا توجد معاملات حديثة.', 'No recent transactions.')}</p>}
        {stats && stats.recent.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('المرجع', 'Reference')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('المرسل', 'Sender')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('الحالة', 'Status')}</th>
                  <th>{t('الوقت', 'Time')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((row) => {
                  const status = statusMeta(row.status)
                  return (
                    <tr key={row.tx_id}>
                      <td className="mono">{row.ontarget_ref ?? row.tx_id}</td>
                      <td className="mono">{money(row.amount, row.currency)}</td>
                      <td>{row.sender_name ?? row.sender_number ?? '—'}</td>
                      <td>{row.merchant ?? '—'}</td>
                      <td><span className={`pay-status-badge ${status.cls}`}>{status.label}</span></td>
                      <td className="mono">{row.first_seen_at ? new Date(row.first_seen_at).toLocaleString() : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PanelShell>
  )
}
