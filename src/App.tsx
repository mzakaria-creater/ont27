import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import PageGate from './auth/PageGate'
import LoginPage from './auth/LoginPage'
import type { NotifData } from './pages/Notifications'
import { api } from './lib/api'
import { UserRoundCheck, UserRoundX } from 'lucide-react'
import { merchantChipCls, money } from './lib/deposits'
import { SUPABASE_URL, SUPABASE_KEY } from './lib/supabase'
import { LocaleProvider, useLocale } from './lib/locale'
import { installNotificationAudioUnlock, playNotificationTone } from './lib/notificationSounds'
import WrongfulDeclineRealtimePopup from './components/WrongfulDeclineRealtimePopup'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Monitor = lazy(() => import('./pages/Monitor'))
const LiveMonitorControl = lazy(() => import('./pages/LiveMonitorControl'))
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
const BinanceP2PEgp = lazy(() => import('./pages/BinanceP2PEgp'))
const BinanceP2PAds = lazy(() => import('./pages/BinanceP2PAds'))
const OperationsArchive = lazy(() => import('./pages/OperationsArchive'))
const WalletReport = lazy(() => import('./pages/WalletReport'))
const WalletInvestigation = lazy(() => import('./pages/WalletInvestigation'))
const WithdrawalSmsReport = lazy(() => import('./pages/WithdrawalSmsReport'))
const Notifications = lazy(() => import('./pages/Notifications'))
const TvScreen = lazy(() => import('./pages/TvScreen'))
const Complaints = lazy(() => import('./pages/Complaints'))
const LinkGenerator = lazy(() => import('./pages/LinkGenerator'))
const PaymentCheckout = lazy(() => import('./pages/PaymentCheckout'))
const PaymentStatus = lazy(() => import('./pages/PaymentStatus'))
const PaymentMethods = lazy(() => import('./pages/PaymentMethods'))
const MerchantPaymentSetup = lazy(() => import('./pages/MerchantPaymentSetup'))
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
const PayoutRequests = lazy(() => import('./pages/PayoutRequests'))
const TeamTasks = lazy(() => import('./pages/TeamTasks'))
const OperatorHandbook = lazy(() => import('./pages/OperatorHandbook'))
const Devices = lazy(() => import('./pages/Devices'))
const StaffAttendance = lazy(() => import('./pages/StaffAttendance'))

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
  const safeArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : []

  useEffect(() => { installNotificationAudioUnlock() }, [])

  useEffect(() => {
    const load = () => void api<NotifData>('/api/notifications').then((next) => {
      // The notifications endpoint may return null/object values while an
      // upstream provider is recovering. Normalize collections at the UI
      // boundary so page navigation can never crash on `.map`.
      const normalized: NotifData = {
        ...next,
        latestPending: safeArray(next.latestPending),
        latestPayouts: safeArray(next.latestPayouts),
        recentMatches: safeArray(next.recentMatches),
        myEditRequests: safeArray(next.myEditRequests),
        offlineDevices: safeArray(next.offlineDevices),
      }
      const latestTx = Math.max(0, ...normalized.latestPending.map((row) => Number(row.tx_id)))
      const latestSms = Number(next.latestSms?.id ?? 0)
      const seen = seenRef.current
      if (seen) {
        if (latestTx > seen.tx) playNotificationTone('transaction')
        if (latestSms > seen.sms) playNotificationTone('sms')
      }
      seenRef.current = { tx: Math.max(seen?.tx ?? 0, latestTx), sms: Math.max(seen?.sms ?? 0, latestSms) }
      setData(normalized)
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
              <Link key={s.id} to={`/sms?sms_id=${s.id}`} className="alert-row" onClick={() => setOpen(false)}>
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

function TelegramTopIcon() {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Array<{ id: number; alert_type: string; message: string | null; created_at: string | null }>>([])
  const [lastSeen, setLastSeen] = useState(() => Number(localStorage.getItem('ontarget:telegram-top-seen') ?? 0))
  useEffect(() => {
    let alive = true
    const load = () => void api<{ alerts?: typeof rows }>('/api/telegram/live?limit=12').then((result) => { if (alive) setRows(result.alerts ?? []) }).catch(() => {})
    load(); const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  const unread = rows.filter((row) => row.id > lastSeen).length
  const markSeen = () => { const latest = Math.max(0, ...rows.map((row) => row.id)); setLastSeen(latest); localStorage.setItem('ontarget:telegram-top-seen', String(latest)) }
  return <div className="top-telegram-wrap">
    <button type="button" className="theme-btn top-chat-btn" title={t('رسائل بوت OnTarget', 'OnTarget bot messages')} aria-label={t('رسائل بوت OnTarget', 'OnTarget bot messages')} aria-expanded={open} onClick={() => { setOpen((value) => !value); markSeen() }}>
      <span aria-hidden="true">✈️</span>{unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="top-telegram-popover" role="dialog" aria-label={t('رسائل Telegram الأخيرة', 'Recent Telegram messages')}>
      <div className="top-telegram-popover-head"><strong>✈️ {t('رسائل OnTarget bot', 'OnTarget bot messages')}</strong><Link to="/telegram" onClick={() => setOpen(false)}>{t('فتح الكل', 'Open all')}</Link></div>
      {rows.length === 0 ? <div className="alert-empty">{t('لا توجد رسائل.', 'No messages.')}</div> : rows.slice(0, 6).map((row) => <Link key={row.id} to="/telegram" className="top-telegram-row" onClick={() => setOpen(false)}><span className="mono">{row.alert_type.replaceAll('_', ' ')}</span><span>{(row.message ?? '—').replace(/<[^>]+>/g, '').slice(0, 100)}</span></Link>)}
    </div>}
  </div>
}

function Topbar() {
  const { user, logout, status, can } = useAuth()
  const { locale, toggleLocale, t } = useLocale()
  const { theme, toggle } = useTheme()
  const [conn, setConn] = useState<Conn>('wait')
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [ago, setAgo] = useState(0)
  const isStaff = ['agent', 'operator', 'operations_admin', 'operator_admin', 'operation_admin'].includes(user?.role ?? '')
  const [attendance, setAttendance] = useState<{ id: string; checked_in_at: string } | null>(null)
  const [attendanceBusy, setAttendanceBusy] = useState(false)
  const [attendanceError, setAttendanceError] = useState(false)

  const loadAttendance = async () => {
    if (!isStaff) return
    try {
      const result = await api<{ active_session: { id: string; checked_in_at: string } | null }>('/api/reports/attendance/me')
      setAttendance(result.active_session)
      setAttendanceError(false)
    } catch {
      setAttendanceError(true)
    }
  }

  const toggleAttendance = async () => {
    if (!user || !isStaff) return
    setAttendanceBusy(true)
    try {
      await api(`/api/reports/attendance/${attendance ? 'check-out' : 'check-in'}`, { method: 'POST', body: JSON.stringify({}) })
      await loadAttendance()
    } catch {
      setAttendanceError(true)
    } finally {
      setAttendanceBusy(false)
    }
  }

  useEffect(() => {
    if (status !== 'authed' || !isStaff) return
    void loadAttendance()
    const iv = window.setInterval(() => void loadAttendance(), 60_000)
    return () => window.clearInterval(iv)
  }, [status, isStaff, user?.id])

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
      {can('telegram_bot') || can('automation') ? <TelegramTopIcon /> : null}
      <Bell />
      {isStaff && <div className="topbar-attendance" title={attendanceError ? t('تعذر قراءة حالة الحضور', 'Unable to read attendance status') : undefined}>
        <span className={`topbar-attendance-state ${attendance ? 'is-in' : 'is-out'}`}><span className="dot" />{attendance ? t('داخل', 'In') : t('خارج', 'Out')}</span>
        <button type="button" className={attendance ? 'btn-ghost btn-sm danger' : 'btn-primary btn-sm'} onClick={() => void toggleAttendance()} disabled={attendanceBusy || attendanceError}>
          {attendance ? <><UserRoundX size={14} />{t('خروج', 'Check out')}</> : <><UserRoundCheck size={14} />{t('دخول', 'Check in')}</>}
        </button>
      </div>}
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
          <WrongfulDeclineRealtimePopup />
        <Suspense fallback={<div className="route-loading" role="status"><span className="ld" /> Loading…</div>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/payment-checkout" element={<PaymentCheckout />} />
          <Route path="/payment-status" element={<PaymentStatus />} />
          <Route path="/account-action" element={<AccountAction />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<PageGate keys={['dashboard']}><AnalyticsDashboard /></PageGate>} />
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/control-room" element={<PageGate keys={['dashboard']}><Dashboard /></PageGate>} />
            <Route path="/monitor" element={<PageGate keys={['dashboard']}><Monitor /></PageGate>} />
            <Route path="/live-monitor" element={<PageGate keys={['dashboard']}><LiveMonitorControl /></PageGate>} />
            <Route path="/api-dashboard" element={<PageGate keys={['dashboard']}><ApiDashboard /></PageGate>} />
            <Route path="/executive-dashboard" element={<PageGate keys={['dashboard','reports','advanced_analysis','treasury','wallets']}><ExecutiveDashboard /></PageGate>} />
            <Route path="/analytics-dashboard" element={<PageGate keys={['dashboard','reports','advanced_analysis','wallets']}><AnalyticsDashboard /></PageGate>} />
            <Route path="/system-health" element={<PageGate keys={['dashboard','automation','audit_log']}><SystemHealth /></PageGate>} />
            <Route path="/performance" element={<PageGate keys={['reports','analytics','dashboard','transactions','merchants']}><Performance /></PageGate>} />
            <Route path="/revenue" element={<PageGate keys={['revenue_center']}><RevenueCenter /></PageGate>} />
            <Route path="/wallet-movements" element={<PageGate keys={['wallets','treasury','reports','sms_live']}><WalletMovements /></PageGate>} />
            <Route path="/walletflow" element={<PageGate keys={['wallets','treasury','reports','sms_live']}><WalletMovements /></PageGate>} />
            <Route path="/client" element={<PageGate keys={['client_crm']}><ClientProfile /></PageGate>} />
            <Route path="/client/:phone" element={<PageGate keys={['client_crm']}><ClientProfile /></PageGate>} />
            <Route path="/deposits" element={<PageGate keys={['deposits']}><Deposits /></PageGate>} />
            <Route path="/payouts" element={<PageGate keys={['payouts']}><Payouts /></PageGate>} />
            <Route path="/payout-requests" element={<PageGate keys={['payouts']}><PayoutRequests /></PageGate>} />
            <Route path="/transactions" element={<PageGate keys={['transactions','all_transactions']}><Transactions /></PageGate>} />
            <Route path="/transactions/:ref" element={<PageGate keys={['transactions','all_transactions','deposits']}><TransactionDetail /></PageGate>} />
            <Route path="/approvals" element={<PageGate keys={['approvals','approval-queue']}><Approvals /></PageGate>} />
            <Route path="/team-tasks" element={<PageGate keys={['support']}><TeamTasks /></PageGate>} />
            <Route path="/operator-handbook" element={<PageGate keys={['support']}><OperatorHandbook /></PageGate>} />
            <Route path="/merchants" element={<PageGate keys={['merchants']}><Merchants /></PageGate>} />
            <Route path="/wallets" element={<PageGate keys={['wallets']}><Wallets /></PageGate>} />
            <Route path="/mavenwallets" element={<PageGate keys={['wallets']}><Wallets /></PageGate>} />
            <Route path="/sms" element={<PageGate keys={['sms_live']}><SmsLive /></PageGate>} />
            <Route path="/settlements" element={<PageGate keys={['settlements','settlements_list','settlement_recon','fees']}><Settlements /></PageGate>} />
            <Route path="/crm" element={<PageGate keys={['client_crm']}><Crm /></PageGate>} />
            <Route path="/risk" element={<PageGate keys={['risk','risk_audit','flagged','exceptions','manual_review','velocity','compliance']}><Risk /></PageGate>} />
            <Route path="/automation" element={<PageGate keys={['automation','automation_rules']}><Automation /></PageGate>} />
            <Route path="/automation-control" element={<Navigate to="/automation" replace />} />
            <Route path="/integration-guide" element={<PageGate keys={['api-keys','settings','merchants']}><IntegrationGuide /></PageGate>} />
            <Route path="/audit" element={<PageGate keys={['audit_log','audit-logs']}><Audit /></PageGate>} />
            <Route path="/reports" element={<PageGate keys={['reports','advanced_analysis']}><Reports /></PageGate>} />
            <Route path="/reportspage" element={<PageGate keys={['reports','advanced_analysis']}><Reports /></PageGate>} />
            <Route path="/hr" element={<PageGate keys={['reports','users']}><StaffAttendance /></PageGate>} />
            <Route path="/staff-attendance" element={<Navigate to="/hr" replace />} />
            <Route path="/review" element={<PageGate keys={['review','audit_log','audit-logs']}><Review /></PageGate>} />
            <Route path="/mismatch" element={<PageGate keys={['review','audit_log','audit-logs','risk','risk_audit','compliance']}><Mismatch /></PageGate>} />
            <Route path="/telegram" element={<PageGate keys={['telegram_bot','automation']}><Telegram /></PageGate>} />
            <Route path="/binance" element={<PageGate keys={['binance_p2p_config','binance_p2p','treasury']}><Binance /></PageGate>} />
            <Route path="/binance/p2p-egp" element={<PageGate keys={['binance_p2p','treasury']}><BinanceP2PEgp /></PageGate>} />
            <Route path="/binance/p2p-history" element={<PageGate keys={['binance_p2p','treasury']}><BinanceP2PEgp /></PageGate>} />
            <Route path="/binance/p2p-ads" element={<PageGate keys={['binance_p2p','treasury']}><BinanceP2PAds /></PageGate>} />
            <Route path="/operations-archive" element={<PageGate keys={['audit_log','audit-logs','transactions']}><OperationsArchive /></PageGate>} />
            <Route path="/wallet-report" element={<PageGate keys={['sms_live','wallets']}><WalletReport /></PageGate>} />
            <Route path="/wallet-investigation" element={<PageGate keys={['sms_live','wallets']}><WalletInvestigation /></PageGate>} />
            <Route path="/withdrawal-sms-report" element={<PageGate keys={['reports','advanced_analysis','sms_live']}><WithdrawalSmsReport /></PageGate>} />
            <Route path="/admin" element={<PageGate keys={['settings','users','permissions']}><AdminPage /></PageGate>} />
            <Route path="/admin/*" element={<PageGate keys={['settings','users','permissions']}><AdminPage /></PageGate>} />
            <Route path="/admin-transactions" element={<PageGate keys={['transactions']}><AdminTransactions /></PageGate>} />
            <Route path="/chat" element={<InternalChat />} />
            <Route path="/notifications" element={<PageGate keys={['notifications']}><Notifications /></PageGate>} />
            <Route path="/tv" element={<PageGate keys={['sms_live']}><TvScreen /></PageGate>} />
            <Route path="/complaints" element={<PageGate keys={['support']}><Complaints /></PageGate>} />
            <Route path="/merchant-link-generator" element={<PageGate keys={['checkout-builder']}><LinkGenerator /></PageGate>} />
            <Route path="/payment-methods" element={<PageGate keys={['wallets','payment_methods']}><PaymentMethods /></PageGate>} />
            <Route path="/merchant-payment-setup" element={<PageGate keys={['wallets','payment_methods']}><MerchantPaymentSetup /></PageGate>} />
            <Route path="/known-recipients" element={<PageGate keys={['wallets','payouts']}><KnownRecipients /></PageGate>} />
            <Route path="/replay-lab" element={<PageGate keys={['automation','sms_live','webhooks']}><ReplayLab /></PageGate>} />
            <Route path="/webhooks" element={<PageGate keys={['webhooks','developers']}><WebhookCenter /></PageGate>} />
            <Route path="/airdroid" element={<PageGate keys={['sms_live','wallets']}><AirDroid /></PageGate>} />
            <Route path="/devices" element={<PageGate keys={['sms_live','wallets']}><Devices /></PageGate>} />
            <Route path="/ontarget-hub" element={<PageGate keys={['wallets','payouts','sms_live','treasury']}><TreasuryHub /></PageGate>} />
            <Route path="/hub" element={<PageGate keys={['wallets','payouts','sms_live','treasury']}><TreasuryHub /></PageGate>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </div>
      </LocaleProvider>
    </BrowserRouter>
  )
}
