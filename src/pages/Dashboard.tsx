import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell, { usePermittedModules } from '../components/PanelShell'
import { api } from '../lib/api'
import { useLocale } from '../lib/locale'
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
  const { t } = useLocale()
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
        <h3>⚡ {t('التحكم السريع', 'Quick control')}</h3>
        {status?.settings && (
          <span className={`pay-status-badge ${on ? 'st-paid' : 'st-declined'}`}>
            {t('الأتمتة', 'Automation')} {on ? t('تعمل', 'on') : t('متوقفة', 'off')}
          </span>
        )}
      </div>
      {!status && <p className="sidebar-hint">{t('جارٍ الاتصال بغرفة التحكم…', 'Connecting to the control room…')}</p>}
      {status && (
        <>
          {statEntries.length > 0 && (
            <div className="flag-grid" style={{ marginBottom: 12 }}>
              {statEntries.map(([k, v]) => (
                <span key={k} className="pay-status-badge st-dim">
                  {STAT_LABELS[k] ?? k}: <b className="mono">{String(v)}</b>
                </span>
              ))}
              <span className="pay-status-badge st-dim">{t('طابور غرفة التحكم', 'Control-room queue')}: <b className="mono">{status.queue.length}</b></span>
            </div>
          )}
          <div className="control-row">
            <button className="btn-primary btn-sm" disabled={busy || on} onClick={() => void act('automation', { on: true }, t('تم تشغيل الأتمتة ✅', 'Automation turned on ✅'))}>
              ▶️ {t('تشغيل', 'On')}
            </button>
            <button className="btn-ghost danger btn-sm" disabled={busy || !on} onClick={() => void act('automation', { on: false }, t('تم إيقاف الأتمتة ⏸️', 'Automation turned off ⏸️'))}>
              ⏸️ {t('إيقاف', 'Off')}
            </button>
            <span className="control-sep" />
            <input
              className="login-input control-input mono"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={t('الحد الأقصى ج.م', 'Max amount EGP')}
            />
            <button
              className="btn-ghost btn-sm"
              disabled={busy || !limit}
              onClick={() => void act('limit', { limit: Number(limit) }, t('تم تحديث الحد 💰', 'Limit updated 💰'))}
            >
              💰 {t('تعديل الحد', 'Edit limit')}
            </button>
          </div>
          {msg && <p className="cell-sub" style={{ marginTop: 8 }}>{msg}</p>}

          {status.queue.length > 0 && (
            <>
              <div className="section-label">🚀 {t('طابور غرفة التحكم', 'Control-room queue')} ({status.queue.length})</div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>tx</th><th>{t('المبلغ', 'Amount')}</th><th>{t('أفضل ترشيح SMS', 'Best SMS match')}</th><th>{t('إجراء', 'Action')}</th></tr></thead>
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
                            <span className="cell-sub">{t('لا يوجد ترشيح', 'No candidate')}</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn-primary btn-sm"
                            disabled={busy || (!item.sms_id && !item.best_guess?.sms_id)}
                            onClick={() => void linkAndApprove(item)}
                          >
                            🚀 {t('اربط واقبل', 'Link & approve')}
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
  const { t } = useLocale()
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
          <h2>{t('مرحباً', 'Welcome')} {user?.display_name ?? user?.username} 👋</h2>
          <p>
            {roleLabel && <>{t('الدور', 'Role')}: <span className="mono">{roleLabel}</span> · </>}
            {t('صلاحيات عرض فعلية على', 'View access on')} {permissions.filter((p) => p.can_view).length} {t('صفحة عبر', 'pages across')} {modules.length} {t('قسم.', 'sections.')}
          </p>
        </div>
      </section>

      {statsErr && (
        <div className="card warn">{t('تعذّر تحميل الإحصائيات — أعد المحاولة أو راجع اتصال الخادم.', 'Failed to load stats — retry or check the server connection.')}</div>
      )}

      {user && CONTROL_ROLES.has(user.role) && <QuickControl />}

      <div className="stat-grid">
        <Link to="/deposits?status=PENDING" className="stat-card stat-pending">
          <span className="stat-label">{t('إيداعات معلّقة', 'Pending deposits')}</span>
          <span className="stat-value">{stats ? stats.pending : '…'}</span>
          <span className="stat-sub">{t('تحتاج مراجعة الآن', 'Need review now')}</span>
        </Link>
        <div className="stat-card">
          <span className="stat-label">{t('مدفوع · آخر 24 ساعة', 'Paid · last 24h')}</span>
          <span className="stat-value">{stats ? money(stats.day.paid.volume, 'EGP') : '…'}</span>
          <span className="stat-sub">{stats ? `${stats.day.paid.count} ${t('عملية', 'txns')}` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('مدفوع · آخر 7 أيام', 'Paid · last 7 days')}</span>
          <span className="stat-value">{stats ? money(stats.week.paid.volume, 'EGP') : '…'}</span>
          <span className="stat-sub">{stats ? `${stats.week.paid.count} ${t('عملية', 'txns')}` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('مرفوض · آخر 24 ساعة', 'Declined · last 24h')}</span>
          <span className="stat-value">{stats ? stats.day.declined : '…'}</span>
          <span className="stat-sub">{stats ? `${t('من إجمالي', 'of')} ${stats.total.toLocaleString('en-US')} ${t('إيداع', 'deposits')}` : ''}</span>
        </div>
      </div>

      <section className="card recent-card">
        <div className="recent-head">
          <h3>{t('أحدث الإيداعات', 'Latest deposits')}</h3>
          <Link to="/deposits" className="pay-status-link">{t('عرض الكل ←', 'View all →')}</Link>
        </div>
        {!stats && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {stats && stats.recent.length === 0 && <p>{t('لا توجد إيداعات بعد.', 'No deposits yet.')}</p>}
        {stats && stats.recent.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('المرجع', 'Ref')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('المُرسِل', 'Sender')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('الحالة', 'Status')}</th>
                  <th>{t('الوقت', 'Time')}</th>
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
              <span className="module-badge">{t('قريباً', 'Soon')}</span>
            </div>
            <h3>{m.label}</h3>
            <ul className="module-pages">
              {m.pages.slice(0, 4).map((p) => (
                <li key={p.page_key}>{labelFor(p.page_key)}</li>
              ))}
              {m.pages.length > 4 && <li>+{m.pages.length - 4} {t('أخرى', 'more')}</li>}
            </ul>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}
