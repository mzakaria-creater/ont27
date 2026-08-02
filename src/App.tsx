import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import LoginPage from './auth/LoginPage'
import Dashboard from './pages/Dashboard'
import Monitor from './pages/Monitor'
import Deposits from './pages/Deposits'
import Payouts from './pages/Payouts'
import Merchants from './pages/Merchants'
import Wallets from './pages/Wallets'
import SmsLive from './pages/SmsLive'
import Transactions from './pages/Transactions'
import TransactionDetail from './pages/TransactionDetail'
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
import PaymentMethods from './pages/PaymentMethods'
import KnownRecipients from './pages/KnownRecipients'
import TreasuryHub from './pages/TreasuryHub'
import { api } from './lib/api'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'
import { LocaleProvider, useLocale } from './lib/locale'

type Conn = 'wait' | 'ok' | 'bad'

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('panel-theme') ?? 'light')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('panel-theme', theme)
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}

function Bell() {
  const { t } = useLocale()
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
      <button className="theme-btn bell-btn" onClick={() => setOpen((o) => !o)} title={t("الإشعارات", "Notifications")} aria-label={t("الإشعارات", "Notifications")}>
        🔔
        {count > 0 && <span className="bell-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && data && (
        <div className="bell-menu">
          <Link to="/deposits?status=PENDING" className="bell-item" onClick={() => setOpen(false)}>
            {t('💰 إيداعات معلّقة', '💰 Pending deposits')} <span className="bell-count">{data.pendingDeposits}</span>
          </Link>
          <Link to="/payouts?status=PENDING" className="bell-item" onClick={() => setOpen(false)}>
            {t('📤 سحوبات معلّقة', '📤 Pending payouts')} <span className="bell-count">{data.pendingPayouts}</span>
          </Link>
          <Link to="/sms?match=review" className="bell-item" onClick={() => setOpen(false)}>
            {t('📨 رسائل تحتاج مراجعة', '📨 SMS awaiting review')} <span className="bell-count">{data.smsReview}</span>
          </Link>
          {data.offlineDevices.length > 0 && (
            <Link to="/wallets" className="bell-item warn-item" onClick={() => setOpen(false)}>
              {t('📵 أجهزة غير متصلة: ', '📵 Offline devices: ')}{data.offlineDevices.join(', ')}
            </Link>
          )}
          <Link to="/notifications" className="bell-item bell-all" onClick={() => setOpen(false)}>
            {t('كل الإشعارات ←', 'All notifications →')}
          </Link>
        </div>
      )}
    </div>
  )
}

function Topbar() {
  const { user, logout, status } = useAuth()
  const { locale, toggleLocale, t } = useLocale()
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
      <span className="live-dot"><span className="ld" />{t('مباشر', 'Live')}</span>
      <div className="spacer" />
      <Bell />
      <button className="theme-btn" onClick={toggleLocale} aria-label={t('تبديل اللغة', 'Switch language')}>
        <span className="theme-btn-label">{locale === 'ar' ? 'EN' : 'AR'}</span>
      </button>
      <button className="theme-btn" onClick={toggle}>
        {theme === 'dark' ? '☀️' : '🌙'}
        <span className="theme-btn-label">{theme === 'dark' ? t('وضع الإضاءة', 'Light mode') : t('الوضع الداكن', 'Dark mode')}</span>
      </button>
      <span className="conn">
        <span className={`dot ${conn}`} />
        {conn === 'ok' ? t('متصل', 'Connected') : conn === 'bad' ? t('غير متصل', 'Offline') : t('جارٍ الفحص…', 'Checking…')}
        {checkedAt && <> · {t(`منذ ${ago} ث`, `${ago}s ago`)}</>}
      </span>
      <span className="user-chip">
        {user?.display_name ?? user?.username} · <span className="mono">{user?.role}</span>
      </span>
      <button className="logout-btn" onClick={() => void logout()}>{t('تسجيل الخروج', 'Sign out')}</button>
    </header>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <LocaleProvider>
        <div className="shell">
          <Topbar />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/payment-checkout" element={<PaymentCheckout />} />
          <Route path="/payment-status" element={<PaymentStatus />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/monitor" element={<Monitor />} />
            <Route path="/deposits" element={<Deposits />} />
            <Route path="/payouts" element={<Payouts />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/transactions/:ref" element={<TransactionDetail />} />
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
            <Route path="/payment-methods" element={<PaymentMethods />} />
            <Route path="/known-recipients" element={<KnownRecipients />} />
            <Route path="/ontarget-hub" element={<TreasuryHub />} />
            <Route path="/hub" element={<TreasuryHub />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </div>
      </LocaleProvider>
    </BrowserRouter>
  )
}