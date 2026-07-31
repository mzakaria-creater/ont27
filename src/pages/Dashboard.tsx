import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell, { usePermittedModules } from '../components/PanelShell'
import { api } from '../lib/api'
import { labelFor } from '../nav/pageCatalog'
import { depositTime, money, statusMeta } from '../lib/deposits'
import type { DepositStats } from '../lib/deposits'

const ROLE_LABELS: Record<string, string> = {
  owner: 'صاحب المنصة',
  super_admin: 'مدير عام',
  admin: 'مدير',
  operations_admin: 'مدير عمليات',
  operator: 'مشغّل',
}

export default function Dashboard() {
  const { user, permissions } = useAuth()
  const modules = usePermittedModules()
  const [stats, setStats] = useState<DepositStats | null>(null)
  const [statsErr, setStatsErr] = useState(false)

  const loadStats = useCallback(async () => {
    try {
      setStats(await api<DepositStats>('/api/deposits/stats'))
      setStatsErr(false)
    } catch {
      setStatsErr(true)
    }
  }, [])

  useEffect(() => {
    void loadStats()
    const iv = setInterval(() => void loadStats(), 30_000)
    return () => clearInterval(iv)
  }, [loadStats])

  const roleLabel = user ? (ROLE_LABELS[user.role] ?? user.role) : ''

  return (
    <PanelShell>
      <section className="welcome-banner">
        <div>
          <h2>مرحباً {user?.display_name ?? user?.username} 👋</h2>
          <p>
            {roleLabel && <>الدور: <span className="mono">{roleLabel}</span> · </>}
            صلاحيات عرض فعلية على {permissions.filter((p) => p.can_view).length} صفحة
            عبر {modules.length} قسم.
          </p>
        </div>
      </section>

      {statsErr && (
        <div className="card warn">تعذّر تحميل الإحصائيات — أعد المحاولة أو راجع اتصال الخادم.</div>
      )}

      <div className="stat-grid">
        <Link to="/deposits?status=PENDING" className="stat-card stat-pending">
          <span className="stat-label">إيداعات معلّقة</span>
          <span className="stat-value">{stats ? stats.pending : '…'}</span>
          <span className="stat-sub">تحتاج مراجعة الآن</span>
        </Link>
        <div className="stat-card">
          <span className="stat-label">مدفوع · آخر 24 ساعة</span>
          <span className="stat-value">{stats ? money(stats.day.paid.volume, 'EGP') : '…'}</span>
          <span className="stat-sub">{stats ? `${stats.day.paid.count} عملية` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">مدفوع · آخر 7 أيام</span>
          <span className="stat-value">{stats ? money(stats.week.paid.volume, 'EGP') : '…'}</span>
          <span className="stat-sub">{stats ? `${stats.week.paid.count} عملية` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">مرفوض · آخر 24 ساعة</span>
          <span className="stat-value">{stats ? stats.day.declined : '…'}</span>
          <span className="stat-sub">{stats ? `من إجمالي ${stats.total.toLocaleString('en-US')} إيداع` : ''}</span>
        </div>
      </div>

      <section className="card recent-card">
        <div className="recent-head">
          <h3>أحدث الإيداعات</h3>
          <Link to="/deposits" className="pay-status-link">عرض الكل ←</Link>
        </div>
        {!stats && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {stats && stats.recent.length === 0 && <p>لا توجد إيداعات بعد.</p>}
        {stats && stats.recent.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>المرجع</th>
                  <th>المبلغ</th>
                  <th>المُرسِل</th>
                  <th>التاجر</th>
                  <th>الحالة</th>
                  <th>الوقت</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((r) => {
                  const st = statusMeta(r.status)
                  return (
                    <tr key={r.tx_id}>
                      <td className="mono">{r.ontarget_ref ?? r.tx_id}</td>
                      <td className="mono">{money(r.amount, r.currency)}</td>
                      <td>{r.sender_name ?? r.sender_number ?? '—'}</td>
                      <td>{r.merchant ?? '—'}</td>
                      <td><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></td>
                      <td className="mono">{depositTime(r)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="module-grid">
        {modules.map((m) => (
          <div key={m.id} className={`module-card${m.priority ? ' priority' : ''}`}>
            <div className="module-card-head">
              <span className="module-icon">{m.icon}</span>
              <span className="module-badge">قريباً</span>
            </div>
            <h3>{m.label}</h3>
            <ul className="module-pages">
              {m.pages.slice(0, 4).map((p) => (
                <li key={p.page_key}>{labelFor(p.page_key)}</li>
              ))}
              {m.pages.length > 4 && <li>+{m.pages.length - 4} أخرى</li>}
            </ul>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}
