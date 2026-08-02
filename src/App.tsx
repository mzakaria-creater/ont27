import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import LoginPage from './auth/LoginPage'
import Dashboard from './pages/Dashboard'
import Deposits from './pages/Deposits'
import Payouts from './pages/Payouts'
import Merchants from './pages/Merchants'
import Wallets from './pages/Wallets'
import SmsLive from './pages/SmsLive'
import Transactions from './pages/Transactions'
import Approvals from './pages/Approvals'
import Settlements from './pages/Settlements'
import Crm from './pages/Crm'
import Risk from './pages/Risk'
import Automation from './pages/Automation'
import Audit from './pages/Audit'
import AdminPage from './pages/AdminPage'
import Reports from './pages/Reports'
import Notifications from './pages/Notifications'
import TvScreen from './pages/TvScreen'
import Complaints from './pages/Complaints'
import type { NotifData } from './pages/Notifications'
import LinkGenerator from './pages/LinkGenerator'
import PaymentCheckout from './pages/PaymentCheckout'
import PaymentStatus from './pages/PaymentStatus'
import { api } from './lib/api'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'

type Conn = 'wait' | 'ok' | 'bad'

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('panel-theme') ?? 'dark')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('panel-theme', theme)
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}

function Bell() {
  const [data, setData] = useState<NotifData | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const load = () => void api<NotifData>('/api/notifications').then(setData).catch(() => {})
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const count = data ? data.pendingDeposits + data.pendingPayouts : 0

  return (
    <div className="bell-wrap" ref={wrapRef}>
      <button className="theme-btn bell-btn" onClick={() => setOpen((o) => !o)} title="الإشعارات">
        🔔
        {count > 0 && <span className="bell-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && data && (
        <div className="bell-menu">
          <Link to="/deposits?status=PENDING" className="bell-item" onClick={() => setOpen(false)}>
            💰 إيداعات معلّقة <span className="bell-count">{data.pendingDeposits}</span>
          </Link>
          <Link to="/payouts?status=PENDING" className="bell-item" onClick={() => setOpen(false)}>
            📤 سحوبات معلّقة <span className="bell-count">{data.pendingPayouts}</span>
          </Link>
          <Link to="/sms?match=review" className="bell-item" onClick={() => setOpen(false)}>
            📨 رسائل تحتاج مراجعة <span className="bell-count">{data.smsReview}</span>
          </Link>
          {data.offlineDevices.length > 0 && (
            <Link to="/wallets" className="bell-item warn-item" onClick={() => setOpen(false)}>
              📵 أجهزة غير متصلة: {data.offlineDevices.join('، ')}
            </Link>
          )}
          <Link to="/notifications" className="bell-item bell-all" onClick={() => setOpen(false)}>
            كل الإشعارات ←
          </Link>
        </div>
      )}
    </div>
  )
}

function Topbar() {
  const { user, logout, status } = useAuth()
  const { theme, toggle } = useTheme()
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
      <span className="live-dot"><span className="ld" />مباشر</span>
      <div className="spacer" />
      <Bell />
      <button className="theme-btn" onClick={toggle}>
        {theme === 'dark' ? '☀️' : '🌙'}
        <span className="theme-btn-label">{theme === 'dark' ? ' وضع الإضاءة' : ' الوضع الداكن'}</span>
      </button>
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
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/merchants" element={<Merchants />} />
            <Route path="/wallets" element={<Wallets />} />
            <Route path="/sms" element={<SmsLive />} />
            <Route path="/settlements" element={<Settlements />} />
            <Route path="/crm" element={<Crm />} />
            <Route path="/risk" element={<Risk />} />
            <Route path="/automation" element={<Automation />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/tv" element={<TvScreen />} />
            <Route path="/complaints" element={<Complaints />} />
            <Route path="/merchant-link-generator" element={<LinkGenerator />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
