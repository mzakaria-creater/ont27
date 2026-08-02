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

const CONTROL_ROLES = new Set(['owner', 'admin', 'super_admin'])

const STAT_LABELS: Record<string, string> = {
  approval_rate: '٪ نسبة القبول',
  today_approved: 'مقبول اليوم',
  today_declined: 'مرفوض اليوم',
  today_pending: 'انتظار',
  jobs_pending: 'طابور',
  jobs_running: 'قيد التنفيذ',
  jobs_completed_today: 'نُفّذ اليوم',
  jobs_failed_today: 'فشل اليوم',
  global_limit: 'الحد العام',
}

interface QueueGuess {
  score: number | null
  amount: number | null
  sms_id: number | null
  reasons: string[] | null
  received_at: string | null
}

interface QueueItem {
  tx_id: number
  amount: number | null
  sms_id: number | null
  best_guess: QueueGuess | null
}

interface ControlStatus {
  settings: { automation_enabled: boolean | null; max_auto_amount: number | null; turbo_mode?: boolean | null } | null
  stats: Record<string, unknown> | null
  queue: QueueItem[]
}

function QuickControl() {
  const [status, setStatus] = useState<ControlStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [limit, setLimit] = useState('')

  const load = useCallback(async () => {
    try {
      const s = await api<ControlStatus>('/api/control/status')
      setStatus(s)
      if (s.settings?.max_auto_amount != null) setLimit(String(s.settings.max_auto_amount))
    } catch {
      setMsg('تعذّر الوصول لغرفة التحكم.')
    }
  }, [])

  useEffect(() => {
    void load()
    const iv = setInterval(() => void load(), 30_000)
    return () => clearInterval(iv)
  }, [load])

  const act = async (path: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await api(`/api/control/${path}`, { method: 'POST', body: JSON.stringify(body) })
      setMsg(okMsg)
      void load()
    } catch {
      setMsg('فشل التنفيذ — أعد المحاولة.')
    } finally {
      setBusy(false)
    }
  }

  const on = status?.settings?.automation_enabled === true
  const statEntries = Object.entries(status?.stats ?? {}).filter(([k]) => STAT_LABELS[k] !== undefined)

  const linkAndApprove = async (item: QueueItem) => {
    const smsId = item.sms_id ?? item.best_guess?.sms_id
    if (!smsId) return
    await act('queue/approve', { tx_id: item.tx_id, sms_id: smsId }, `تم ربط وقبول ${item.tx_id} ✅`)
  }

  return (
    <section className="card recent-card">
      <div className="recent-head">
        <h3>⚡ التحكم السريع</h3>
        {status?.settings && (
          <span className={`pay-status-badge ${on ? 'st-paid' : 'st-declined'}`}>
            الأتمتة {on ? 'تعمل' : 'متوقفة'}
          </span>
        )}
      </div>
      {!status && <p className="sidebar-hint">جارٍ الاتصال بغرفة التحكم…</p>}
      {status && (
        <>
          {statEntries.length > 0 && (
            <div className="flag-grid" style={{ marginBottom: 12 }}>
              {statEntries.map(([k, v]) => (
                <span key={k} className="pay-status-badge st-dim">
                  {STAT_LABELS[k] ?? k}: <b className="mono">{String(v)}</b>
                </span>
              ))}
              <span className="pay-status-badge st-dim">طابور غرفة التحكم: <b className="mono">{status.queue.length}</b></span>
            </div>
          )}
          <div className="control-row">
            <button className="btn-primary btn-sm" disabled={busy || on} onClick={() => void act('automation', { on: true }, 'تم تشغيل الأتمتة ✅')}>
              ▶️ تشغيل
            </button>
            <button className="btn-ghost danger btn-sm" disabled={busy || !on} onClick={() => void act('automation', { on: false }, 'تم إيقاف الأتمتة ⏸️')}>
              ⏸️ إيقاف
            </button>
            <span className="control-sep" />
            <input
              className="login-input control-input mono"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="الحد الأقصى ج.م"
            />
            <button
              className="btn-ghost btn-sm"
              disabled={busy || !limit}
              onClick={() => void act('limit', { limit: Number(limit) }, 'تم تحديث الحد 💰')}
            >
              💰 تعديل الحد
            </button>
          </div>
          {msg && <p className="cell-sub" style={{ marginTop: 8 }}>{msg}</p>}

          {status.queue.length > 0 && (
            <>
              <div className="section-label">🚀 طابور غرفة التحكم ({status.queue.length})</div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>tx</th><th>المبلغ</th><th>أفضل ترشيح SMS</th><th>إجراء</th></tr></thead>
                  <tbody>
                    {status.queue.slice(0, 10).map((item) => (
                      <tr key={item.tx_id}>
                        <td className="mono">{item.tx_id}</td>
                        <td className="mono">{money(item.amount, 'EGP')}</td>
                        <td>
                          {item.best_guess?.sms_id ? (
                            <>
                              <span className="mono">#{item.best_guess.sms_id}</span>
                              {' '}<span className="pay-status-badge st-pending">score {item.best_guess.score ?? '—'}</span>
                              {item.best_guess.reasons && <div className="cell-sub">{item.best_guess.reasons.join(' · ')}</div>}
                            </>
                          ) : (
                            <span className="cell-sub">لا يوجد ترشيح</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn-primary btn-sm"
                            disabled={busy || (!item.sms_id && !item.best_guess?.sms_id)}
                            onClick={() => void linkAndApprove(item)}
                          >
                            🚀 اربط واقبل
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
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

      {user && CONTROL_ROLES.has(user.role) && <QuickControl />}

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
