import { useEffect, useMemo, useState } from 'react'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'
import { useAuth } from './auth/AuthContext'
import { CATEGORIES, categoryFor, labelFor } from './nav/pageCatalog'

type Conn = 'wait' | 'ok' | 'bad'

const ROLE_LABELS: Record<string, string> = {
  owner: 'صاحب المنصة',
  super_admin: 'مدير عام',
  admin: 'مدير',
  operations_admin: 'مدير عمليات',
  operator: 'مشغّل',
}

export default function Dashboard() {
  const { user, permissions, logout } = useAuth()
  const [conn, setConn] = useState<Conn>('wait')
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [ago, setAgo] = useState(0)

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
          headers: { apikey: SUPABASE_KEY },
        })
        if (!alive) return
        setConn(res.ok ? 'ok' : 'bad')
      } catch {
        if (alive) setConn('bad')
      }
      if (alive) setCheckedAt(new Date())
    }
    check()
    const iv = setInterval(check, 30_000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])

  useEffect(() => {
    const iv = setInterval(() => {
      if (checkedAt) setAgo(Math.round((Date.now() - checkedAt.getTime()) / 1000))
    }, 1000)
    return () => clearInterval(iv)
  }, [checkedAt])

  // Group this role's *actual* view permissions by category — a page never
  // appears in the nav unless role_page_permissions grants can_view on it.
  const modules = useMemo(() => {
    const byCategory = new Map<string, typeof permissions>()
    for (const p of permissions) {
      if (!p.can_view || p.page_key === 'dashboard') continue
      const cat = categoryFor(p.page_key)
      if (!byCategory.has(cat)) byCategory.set(cat, [])
      byCategory.get(cat)!.push(p)
    }
    return CATEGORIES.filter((c) => byCategory.has(c.id)).map((c) => ({
      ...c,
      pages: byCategory.get(c.id)!,
    }))
  }, [permissions])

  const permsLoaded = permissions.length > 0
  const roleLabel = user ? (ROLE_LABELS[user.role] ?? user.role) : ''

  return (
    <div className="shell">
      <header className="topbar">
        <img src="/logo.svg" alt="OnTarget" className="logo" />
        <h1>
          OnTarget <span className="brand-sub">Payment Provider</span>
        </h1>
        <div className="spacer" />
        <span className="conn">
          <span className={`dot ${conn}`} />
          {conn === 'ok' ? 'متصل' : conn === 'bad' ? 'غير متصل' : 'جارٍ الفحص…'}
          {checkedAt && <>· آخر تحديث: منذ {ago} ثانية</>}
        </span>
        <span className="user-chip">
          {user?.display_name ?? user?.username} · <span className="mono">{user?.role}</span>
        </span>
        <button className="logout-btn" onClick={() => void logout()}>
          تسجيل الخروج
        </button>
      </header>

      <div className="dash-body">
        <nav className="sidebar">
          <div className="sidebar-item active">
            <span className="sidebar-icon">🏠</span>
            <span>لوحة التحكم</span>
          </div>
          {!permsLoaded && <div className="sidebar-hint">جارٍ تحميل الصلاحيات…</div>}
          {modules.map((m) => (
            <div key={m.id} className="sidebar-item soon" title="قريباً">
              <span className="sidebar-icon">{m.icon}</span>
              <span>{m.label}</span>
              <span className="sidebar-count">{m.pages.length}</span>
            </div>
          ))}
        </nav>

        <main className="dash-main">
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

          <section className="priority-callout">
            <span className="priority-badge">التالي في البناء</span>
            <div>
              <strong>الإيداعات (Deposits)</strong>
              <p>الأولوية التشغيلية القصوى حسب خطة البناء — راجع docs/HANDBOOK.md §5.</p>
            </div>
          </section>

          {modules.length === 0 && permsLoaded && (
            <div className="card">
              <p>لا توجد صفحات مُتاحة لدورك الحالي بعد.</p>
            </div>
          )}

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
        </main>
      </div>
    </div>
  )
}
