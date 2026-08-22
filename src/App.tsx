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
import Review from './pages/Review'
import Mismatch from './pages/Mismatch'
import Telegram from './pages/Telegram'
import Binance from './pages/Binance'
import OperationsArchive from './pages/OperationsArchive'
import WalletReport from './pages/WalletReport'
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
import ExecutiveDashboard from './pages/ExecutiveDashboard'
import AnalyticsDashboard from './pages/AnalyticsDashboard'
import SystemHealth from './pages/SystemHealth'
import Performance from './pages/Performance'
import WalletMovements from './pages/WalletMovements'
import ClientProfile from './pages/ClientProfile'
import { api } from './lib/api'
import { merchantChipCls, money } from './lib/deposits'
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
        <div className="bell-menu alert-center">
          <div className="alert-head">
            <strong>{t('مركز التنبيهات المباشر', 'Live alert center')}</strong>
            <span className="live-dot"><span className="ld" />{t('حي', 'Live')}</span>
          </div>

          <div className="alert-section">
            <Link to="/deposits?status=PENDING" className="alert-section-head" onClick={() => setOpen(false)}>
              <span>💰 {t('طابور الإيداعات', 'Deposits queue')}</span>
              <span className="bell-count">{data.pendingDeposits}</span>
            </Link>
            {(data.pendingDepositsStale ?? 0) > 0 && <div className="alert-empty">{t(`${data.pendingDepositsStale} معاملات Pending قديمة خارج التنبيه الحي`, `${data.pendingDepositsStale} old pending records excluded from the live alert`)}</div>}
            {(data.latestPending ?? []).length === 0 && <div className="alert-empty">{t('لا شيء معلّق', 'Nothing pending')}</div>}
            {(data.latestPending ?? []).map((r) => (
              <Link key={r.tx_id} to={r.ontarget_ref ? `/transactions/${r.ontarget_ref}` : '/deposits?status=PENDING'} className="alert-row" onClick={() => setOpen(false)}>
                <span className="mono">{r.ontarget_ref ?? r.tx_id}</span>
                <span className="alert-row-mid">
                  {r.sender_name ?? '—'}
                  {r.master_merchant && <span className={`merchant-chip ${merchantChipCls(r.master_merchant)}`}>{r.master_merchant}</span>}
                </span>
                <span className="mono">{money(r.amount, r.currency)}</span>
              </Link>
            ))}
          </div>

          <div className="alert-section">
            <Link to="/payouts?status=PENDING" className="alert-section-head" onClick={() => setOpen(false)}>
              <span>📤 {t('طابور السحوبات', 'Payouts queue')}</span>
              <span className="bell-count">{data.pendingPayouts}</span>
            </Link>
            {(data.latestPayouts ?? []).length === 0 && <div className="alert-empty">{t('لا شيء معلّق', 'Nothing pending')}</div>}
            {(data.latestPayouts ?? []).map((r) => (
              <Link key={r.maven_id} to={`/payouts?status=PENDING&q=${encodeURIComponent(r.ontarget_ref ?? String(r.maven_id))}`} className="alert-row" onClick={() => setOpen(false)}>
                <span className="mono">{r.ontarget_ref ?? r.maven_id}</span>
                <span className="alert-row-mid">{r.account_name ?? r.mobile_no ?? '—'}</span>
                <span className="mono">{money(r.amount, 'EGP')}</span>
              </Link>
            ))}
          </div>

          <div className="alert-section">
            <Link to="/sms" className="alert-section-head" onClick={() => setOpen(false)}>
              <span>📨 {t('آخر الرسائل المطابَقة', 'Recent SMS matches')}</span>
              {data.smsReview > 0 && <span className="bell-count warn">{t(`${data.smsReview} للمراجعة`, `${data.smsReview} to review`)}</span>}
            </Link>
            {(data.recentMatches ?? []).length === 0 && <div className="alert-empty">{t('لا توجد مطابقات حديثة', 'No recent matches')}</div>}
            {(data.recentMatches ?? []).map((s) => (
              <Link key={s.id} to="/sms" className="alert-row" onClick={() => setOpen(false)}>
                <span className="mono">{s.device_name ?? '—'}</span>
                <span className="alert-row-mid">{s.sender_name ?? '—'}</span>
                <span className="mono">{money(s.amount, 'EGP')}</span>
              </Link>
            ))}
          </div>

          {(data.myEditRequests ?? []).length > 0 && (
            <div className="alert-section">
              <div className="alert-section-head">
                <span>✏️ {t('طلبات التعديل الخاصة بك', 'Your edit requests')}</span>
              </div>
              {(data.myEditRequests ?? []).map((r) => {
                const settled =
                  r.status === 'applied' ? { icon: '✅', cls: '', label: t('نُفِّذ', 'Applied') }
                  : r.status === 'rejected' ? { icon: '❌', cls: 'warn-item', label: t('رُفض', 'Rejected') }
                  : { icon: '⚠️', cls: 'warn-item', label: t('فشل التنفيذ', 'Apply failed') }
                return (
                  <Link
                    key={r.id}
                    to={`/transactions/${r.tx_id}`}
                    className={`bell-item ${settled.cls}`}
                    onClick={() => setOpen(false)}
                  >
                    <span>{settled.icon} <span className="mono">{r.ontarget_ref ?? r.tx_id}</span> · {settled.label}</span>
                    <span className="alert-row-mid">
                      {r.decided_by ? t(`بواسطة ${r.decided_by}`, `by ${r.decided_by}`) : ''}
                    </span>
                  </Link>
                )
              })}
            </div>
          )}

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
            <Route path="/" element={<AnalyticsDashboard />} />
            <Route path="/control-room" element={<Dashboard />} />
            <Route path="/monitor" element={<Monitor />} />
            <Route path="/executive-dashboard" element={<ExecutiveDashboard />} />
            <Route path="/analytics-dashboard" element={<AnalyticsDashboard />} />
            <Route path="/system-health" element={<SystemHealth />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/wallet-movements" element={<WalletMovements />} />
            <Route path="/client" element={<ClientProfile />} />
            <Route path="/client/:phone" element={<ClientProfile />} />
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
            <Route path="/review" element={<Review />} />
            <Route path="/mismatch" element={<Mismatch />} />
            <Route path="/telegram" element={<Telegram />} />
            <Route path="/binance" element={<Binance />} />
            <Route path="/operations-archive" element={<OperationsArchive />} />
            <Route path="/wallet-report" element={<WalletReport />} />
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
