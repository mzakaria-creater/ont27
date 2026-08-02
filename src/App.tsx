import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import LoginPage from './auth/LoginPage'
import Dashboard from './pages/Dashboard'
import Deposits from './pages/Deposits'
import Payouts from './pages/Payouts'
import Merchants from './pages/Merchants'
import Wallets from './pages/Wallets'
import PaymentCheckout from './pages/PaymentCheckout'
import PaymentStatus from './pages/PaymentStatus'
import LinkGenerator from './pages/LinkGenerator'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'

type Conn = 'wait' | 'ok' | 'bad'

function Topbar() {
  const { user, logout, status } = useAuth()
  const [conn, setConn] = useState<Conn>('wait')
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [ago, setAgo] = useState(0)

  useEffect(() => {
    if (status !== 'authed') return
    let alive = true
    const check = async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_KEY } })
        if (alive) setConn(res.ok ? 'ok' : 'bad')
      } catch {
        if (alive) setConn('bad')
      }
      if (alive) setCheckedAt(new Date())
    }
    void check()
    const iv = setInterval(check, 30_000)
    return () => { alive = false; clearInterval(iv) }
  }, [status])

  useEffect(() => {
    const iv = setInterval(() => {
      if (checkedAt) setAgo(Math.round((Date.now() - checkedAt.getTime()) / 1000))
    }, 1000)
    return () => clearInterval(iv)
  }, [checkedAt])

  if (status !== 'authed') return null
  return (
    <header className="topbar">
      <img src="/logo.svg" alt="OnTarget" className="logo" />
      <h1><Link to="/" className="home-link">OnTarget <span className="brand-sub">Payment Provider</span></Link></h1>
      <div className="spacer" />
      <span className="conn">
        <span className={`dot ${conn}`} />
        {conn === 'ok' ? 'متصل' : conn === 'bad' ? 'غير متصل' : 'جارٍ الفحص…'}
        {checkedAt && <> · منذ {ago} ث</>}
      </span>
      <span className="user-chip">
        {user?.display_name ?? user?.username} · <span className="mono">{user?.role}</span>
      </span>
      <button className="logout-btn" onClick={() => void logout()}>تسجيل الخروج</button>
    </header>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="shell">
        <Topbar />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/payment-checkout" element={<PaymentCheckout />} />
          <Route path="/payment-status" element={<PaymentStatus />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/deposits" element={<Deposits />} />
            <Route path="/payouts" element={<Payouts />} />
            <Route path="/merchants" element={<Merchants />} />
            <Route path="/wallets" element={<Wallets />} />
            <Route path="/merchant-link-generator" element={<LinkGenerator />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
