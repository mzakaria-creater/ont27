import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import PageGate from './auth/PageGate'
import LoginPage from './auth/LoginPage'
import type { NotifData } from './pages/Notifications'
import { api } from './lib/api'
import { merchantChipCls, money } from './lib/deposits'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'
import { LocaleProvider, useLocale } from './lib/locale'
import { installNotificationAudioUnlock, playNotificationTone } from './lib/notificationSounds'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Monitor = lazy(() => import('./pages/Monitor'))
const Deposits = lazy(() => import('./pages/Deposits'))
const Payouts = lazy(() => import('./pages/Payouts'))
const Merchants = lazy(() => import('./pages/Merchants'))
const Wallets = lazy(() => import('./pages/Wallets'))
const SmsLive = lazy(() => import('./pages/SmsLive'))
const Transactions = lazy(() => import('./pages/Transactions'))
const TransactionDetail = lazy(() => import('./pages/TransactionDetail'))
const Approvals = lazy(() => import('./pages/Approvals'))
const Settlements = lazy(() => import('./pages/Settlements'))
const Crm = lazy(() => import('./pages/Crm'))
const Risk = lazy(() => import('./pages/Risk'))
const Automation = lazy(() => import('./pages/Automation'))
const Audit = lazy(() => import('./pages/Audit'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const Reports = lazy(() => import('./pages/Reports'))
const Review = lazy(() => import('./pages/Review'))
const Mismatch = lazy(() => import('./pages/Mismatch'))
const Telegram = lazy(() => import('./pages/Telegram'))
const Binance = lazy(() => import('./pages/Binance'))
const OperationsArchive = lazy(() => import('./pages/OperationsArchive'))
const WalletReport = lazy(() => import('./pages/WalletReport'))
const WithdrawalSmsReport = lazy(() => import('./pages/WithdrawalSmsReport'))
const Notifications = lazy(() => import('./pages/Notifications'))
const TvScreen = lazy(() => import('./pages/TvScreen'))
const Complaints = lazy(() => import('./pages/Complaints'))
const LinkGenerator = lazy(() => import('./pages/LinkGenerator'))
const PaymentCheckout = lazy(() => import('./pages/PaymentCheckout'))
const PaymentStatus = lazy(() => import('./pages/PaymentStatus'))
const PaymentMethods = lazy(() => import('./pages/PaymentMethods'))
const KnownRecipients = lazy(() => import('./pages/KnownRecipients'))
const TreasuryHub = lazy(() => import('./pages/TreasuryHub'))
const ExecutiveDashboard = lazy(() => import('./pages/ExecutiveDashboard'))
const AnalyticsDashboard = lazy(() => import('./pages/AnalyticsDashboard'))
const SystemHealth = lazy(() => import('./pages/SystemHealth'))
const Performance = lazy(() => import('./pages/Performance'))
const WalletMovements = lazy(() => import('./pages/WalletMovements'))
const ClientProfile = lazy(() => import('./pages/ClientProfile'))
const ReplayLab = lazy(() => import('./pages/ReplayLab'))
const AirDroid = lazy(() => import('./pages/AirDroid'))
const AdminTransactions = lazy(() => import('./pages/AdminTransactions'))
const ApiDashboard = lazy(() => import('./pages/ApiDashboard'))
const InternalChat = lazy(() => import('./pages/InternalChat'))
const IntegrationGuide = lazy(() => import('./pages/IntegrationGuide'))
const RevenueCenter = lazy(() => import('./pages/RevenueCenter'))
const Welcome = lazy(() => import('./pages/Welcome'))
const AccountAction = lazy(() => import('./pages/AccountAction'))
const WebhookCenter = lazy(() => import('./pages/WebhookCenter'))

type Conn = 'wait' | 'ok' | 'bad'

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('panel-theme') === 'light' ? 'light' : 'dark')
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
  const seenRef = useRef<{ tx: number; sms: number } | null>(null)

  useEffect(() => { installNotificationAudioUnlock() }, [])

  useEffect(() => {
    const load = () => void api<NotifData>('/api/notifications').then((next) => {
      const latestTx = Math.max(0, ...(next.latestPending ?? []).map((row) => Number(row.tx_id)))
      const latestSms = Number(next.latestSms?.id ?? 0)
      const seen = seenRef.current
      if (seen) {
        if (latestTx > seen.tx) playNotificationTone('transaction')
        if (latestSms > seen.sms) playNotificationTone('sms')
      }
      seenRef.current = { tx: Math.max(seen?.tx ?? 0, latestTx), sms: Math.max(seen?.sms ?? 0, latestSms) }
      setData(next)
    }).catch(() => {})
    load()
    const iv = setInterval(load, 10_000)
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

function ChatTopIcon() {
  const { t } = useLocale()
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    const update = (event: Event) => setUnread(Number((event as CustomEvent<number>).detail ?? 0))
    window.addEventListener('ontarget:chat-unread', update)
    return () => window.removeEventListener('ontarget:chat-unread', update)
  }, [])
  return <Link to="/chat" className="theme-btn top-chat-btn" title={t('محادثات الفريق', 'Internal Chat')} aria-label={t('محادثات الفريق', 'Internal Chat')}>
    <span aria-hidden="true">💬</span>
    {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
  </Link>
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
      <ChatTopIcon />
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
        <Suspense fallback={<div className="route-loading" role="status"><span className="ld" /> Loading…</div>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/payment-checkout" element={<PaymentCheckout />} />
          <Route path="/payment-status" element={<PaymentStatus />} />
          <Route path="/account-action" element={<AccountAction />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<PageGate keys={['dashboard']}><AnalyticsDashboard /></PageGate>} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/control-room" element={<Dashboard />} />
            <Route path="/monitor" element={<Monitor />} />
            <Route path="/api-dashboard" element={<ApiDashboard />} />
            <Route path="/executive-dashboard" element={<ExecutiveDashboard />} />
            <Route path="/analytics-dashboard" element={<AnalyticsDashboard />} />
            <Route path="/system-health" element={<SystemHealth />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/revenue" element={<RevenueCenter />} />
            <Route path="/wallet-movements" element={<WalletMovements />} />
            <Route path="/client" element={<ClientProfile />} />
            <Route path="/client/:phone" element={<ClientProfile />} />
            <Route path="/deposits" element={<PageGate keys={['deposits']}><Deposits /></PageGate>} />
            <Route path="/payouts" element={<PageGate keys={['payouts']}><Payouts /></PageGate>} />
            <Route path="/transactions" element={<PageGate keys={['transactions','all_transactions']}><Transactions /></PageGate>} />
            <Route path="/transactions/:ref" element={<PageGate keys={['transactions','all_transactions','deposits']}><TransactionDetail /></PageGate>} />
            <Route path="/approvals" element={<PageGate keys={['approvals','approval-queue']}><Approvals /></PageGate>} />
            <Route path="/merchants" element={<Merchants />} />
            <Route path="/wallets" element={<Wallets />} />
            <Route path="/sms" element={<SmsLive />} />
            <Route path="/settlements" element={<Settlements />} />
            <Route path="/crm" element={<Crm />} />
            <Route path="/risk" element={<Risk />} />
            <Route path="/automation" element={<PageGate keys={['automation','automation_rules']}><Automation /></PageGate>} />
            <Route path="/automation-control" element={<PageGate keys={['automation','automation_rules']}><Automation /></PageGate>} />
            <Route path="/integration-guide" element={<IntegrationGuide />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/review" element={<Review />} />
            <Route path="/mismatch" element={<Mismatch />} />
            <Route path="/telegram" element={<Telegram />} />
            <Route path="/binance" element={<Binance />} />
            <Route path="/operations-archive" element={<OperationsArchive />} />
            <Route path="/wallet-report" element={<WalletReport />} />
            <Route path="/withdrawal-sms-report" element={<WithdrawalSmsReport />} />
            <Route path="/admin" element={<PageGate keys={['settings','users','permissions']}><AdminPage /></PageGate>} />
            <Route path="/admin/*" element={<PageGate keys={['settings','users','permissions']}><AdminPage /></PageGate>} />
            <Route path="/admin-transactions" element={<AdminTransactions />} />
            <Route path="/chat" element={<InternalChat />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/tv" element={<TvScreen />} />
            <Route path="/complaints" element={<Complaints />} />
            <Route path="/merchant-link-generator" element={<LinkGenerator />} />
            <Route path="/payment-methods" element={<PaymentMethods />} />
            <Route path="/known-recipients" element={<KnownRecipients />} />
            <Route path="/replay-lab" element={<ReplayLab />} />
            <Route path="/webhooks" element={<PageGate keys={['webhooks','developers']}><WebhookCenter /></PageGate>} />
            <Route path="/airdroid" element={<AirDroid />} />
            <Route path="/ontarget-hub" element={<TreasuryHub />} />
            <Route path="/hub" element={<TreasuryHub />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </div>
      </LocaleProvider>
    </BrowserRouter>
  )
}
