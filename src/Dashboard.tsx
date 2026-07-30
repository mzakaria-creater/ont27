import { useEffect, useState } from 'react'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'
import { useAuth } from './auth/AuthContext'

type Conn = 'wait' | 'ok' | 'bad'

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

  const viewablePages = permissions.filter((p) => p.can_view).length

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
      <main className="main">
        <div className="card">
          <h2>مرحباً {user?.display_name ?? user?.username} 👋</h2>
          <p>
            تسجيل الدخول تم بنجاح عبر <span className="mono">panel-v2</span>. الدور الحالي:{' '}
            <span className="mono">{user?.role}</span> — صلاحيات عرض على {viewablePages} صفحة.
          </p>
          <p>
            الترتيب القادم للبناء: Dashboard ← Deposits (الأولوية التشغيلية القصوى) ← Payouts
            ← Merchants/Wallets/CRM ← Automation ← Devices ← Integrations.
          </p>
        </div>
      </main>
    </div>
  )
}
