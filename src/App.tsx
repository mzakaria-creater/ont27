import { useEffect, useState } from 'react'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'

type Conn = 'wait' | 'ok' | 'bad'

export default function App() {
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
    return () => { alive = false; clearInterval(iv) }
  }, [])

  useEffect(() => {
    const iv = setInterval(() => {
      if (checkedAt) setAgo(Math.round((Date.now() - checkedAt.getTime()) / 1000))
    }, 1000)
    return () => clearInterval(iv)
  }, [checkedAt])

  return (
    <div className="shell">
      <header className="topbar">
        <img src="/logo.svg" alt="OnTarget" className="logo" />
        <h1>OnTarget <span className="brand-sub">Payment Provider</span></h1>
        <div className="spacer" />
        <span className="conn">
          <span className={`dot ${conn}`} />
          {conn === 'ok' ? 'متصل' : conn === 'bad' ? 'غير متصل' : 'جارٍ الفحص…'}
          {checkedAt && <>· آخر تحديث: منذ {ago} ثانية</>}
        </span>
      </header>
      <main className="main">
        <div className="card">
          <h2>OnTarget Panel v2 — الأساس جاهز</h2>
          <p>
            الواجهة متصلة بقاعدة البيانات الجديدة
            {' '}<span className="mono">ontarget-panel-v2</span>{' '}
            (<span className="mono">iwhjmhazcvctvipoasct</span>).
          </p>
          <p>
            الترتيب القادم للبناء: Auth + RBAC ← Dashboard ← Deposits ← Payouts
            ← Merchants/Wallets/CRM ← Automation ← Devices ← Integrations.
          </p>
        </div>
      </main>
    </div>
  )
}
