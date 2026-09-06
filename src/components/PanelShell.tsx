import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { CATEGORIES, categoryFor } from '../nav/pageCatalog'
import { api } from '../lib/api'
import { syncProviders } from '../lib/providerSync'
import { depositTime, money } from '../lib/deposits'
import type { PagePermission } from '../lib/api'
import { useLocale } from '../lib/locale'
import { installNotificationAudioUnlock, playNotificationTone } from '../lib/notificationSounds'
import { BarChart3, Bot, ChevronDown, CircleDollarSign, LayoutDashboard, Menu, MessageSquareText, Minimize2, PanelLeftClose, PanelLeftOpen, Search, Send, Settings, Users, WalletCards, X } from 'lucide-react'

// Shared authed layout ("Live Transaction Monitor" skin): nav rail (real pages
// first, then the role's remaining permitted modules as "قريباً" placeholders),
// main content, and an always-on live SMS rail for roles with sms_live access.

type NavGroupId = 'overview' | 'transactions' | 'payments' | 'customers' | 'automation' | 'insights' | 'admin'

interface NavLinkDef {
  to: string
  icon: string
  labelAr: string
  labelEn: string
  /** visible when the role can_view ANY of these keys; empty = always */
  keys: string[]
  /**
   * Roles the SERVER additionally requires. Only for pages whose API is gated
   * by role rather than by permission — /admin runs behind requireAdminRole.
   * Without this the link rendered for any role holding can_view on 'settings'
   * (19 of 21 roles), and clicking it produced "This page is for owner or
   * admin only". The nav now asks the same question the server asks.
   */
  roles?: string[]
  group: NavGroupId
}

// Mirrors ADMIN_ROLES in server/rbac.ts. Kept in sync by hand — the server
// stays the enforcement point; this only decides whether to draw the link.
const ADMIN_ROLES = ['owner', 'admin', 'super_admin']
const TRANSACTION_ADMIN_ROLES = [...ADMIN_ROLES, 'operations_admin']
// Mirrors the ALLOWED set in server/complaints.ts, which is also role-gated
// rather than permission-gated — every role holds can_view on 'support', so
// the key alone would keep showing the link to the 16 roles the API refuses.
const COMPLAINT_ROLES = ['owner', 'admin', 'super_admin', 'operator', 'operations_admin']

// Ordered nav groups. Only groups with at least one visible link render.
const NAV_GROUPS: { id: NavGroupId; ar: string; en: string }[] = [
  { id: 'overview', ar: 'نظرة عامة', en: 'Overview' },
  { id: 'transactions', ar: 'المعاملات', en: 'Transactions' },
  { id: 'payments', ar: 'المدفوعات والمحافظ', en: 'Payments & wallets' },
  { id: 'customers', ar: 'العملاء والتجار', en: 'Customers & merchants' },
  { id: 'automation', ar: 'الأتمتة والمخاطر', en: 'Automation & risk' },
  { id: 'insights', ar: 'التقارير والتحليلات', en: 'Reports & insights' },
  { id: 'admin', ar: 'النظام والإدارة', en: 'System & admin' },
]

const NAV_GROUP_ICONS: Record<NavGroupId, ReactNode> = {
  overview: <LayoutDashboard size={16} strokeWidth={2} />,
  transactions: <CircleDollarSign size={16} strokeWidth={2} />,
  payments: <WalletCards size={16} strokeWidth={2} />,
  customers: <Users size={16} strokeWidth={2} />,
  automation: <Bot size={16} strokeWidth={2} />,
  insights: <BarChart3 size={16} strokeWidth={2} />,
  admin: <Settings size={16} strokeWidth={2} />,
}

const BUILT_LINKS: NavLinkDef[] = [
  // Main — dashboards & live monitoring
  { to: '/', icon: '🏠', labelAr: 'لوحة التحكم', labelEn: 'Dashboard', keys: ['dashboard'], group: 'overview' },
  { to: '/control-room', icon: '🎛️', labelAr: 'غرفة التحكم', labelEn: 'Control room', keys: ['dashboard'], group: 'overview' },
  { to: '/monitor', icon: '📡', labelAr: 'المراقبة المباشرة', labelEn: 'Live Monitor', keys: ['dashboard'], group: 'overview' },
  { to: '/live-monitor', icon: '🔴', labelAr: 'مراقبة العمليات', labelEn: 'Operations Monitor', keys: ['dashboard'], group: 'overview' },
  { to: '/api-dashboard', icon: '◆', labelAr: 'لوحة API', labelEn: 'API Dashboard', keys: ['dashboard'], group: 'overview' },
  { to: '/executive-dashboard', icon: '▦', labelAr: 'لوحة الإدارة التنفيذية', labelEn: 'Executive Dashboard', keys: ['dashboard', 'reports', 'advanced_analysis', 'treasury', 'wallets'], group: 'insights' },
  { to: '/analytics-dashboard', icon: '◫', labelAr: 'لوحة التحليلات', labelEn: 'Analytics Dashboard', keys: ['dashboard', 'reports', 'advanced_analysis', 'wallets'], group: 'insights' },
  { to: '/system-health', icon: '♥', labelAr: 'حالة النظام', labelEn: 'System Health', keys: ['dashboard', 'automation', 'audit'], group: 'admin' },
  { to: '/performance', icon: '📈', labelAr: 'أداء المزوّدين والتجار', labelEn: 'Provider & merchant performance', keys: ['reports', 'analytics', 'dashboard', 'transactions', 'merchants'], group: 'insights' },
  { to: '/revenue', icon: '◈', labelAr: 'الإيرادات والعمولات', labelEn: 'Revenue & Commission', keys: ['revenue_center'], group: 'insights' },
  // Operations — the daily transaction workflow
  { to: '/approvals', icon: '✅', labelAr: 'طابور الموافقات', labelEn: 'Approval queue', keys: ['approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me'], group: 'transactions' },
  { to: '/team-tasks', icon: '🗂️', labelAr: 'مهام فريق الدعم', labelEn: 'Team support tasks', keys: ['support'], group: 'transactions' },
  { to: '/operator-handbook', icon: '📖', labelAr: 'دليل المشغّل', labelEn: 'Operator handbook', keys: ['support'], group: 'transactions' },
  { to: '/deposits', icon: '💰', labelAr: 'الإيداعات', labelEn: 'Deposits', keys: ['deposits'], group: 'transactions' },
  { to: '/payouts', icon: '📤', labelAr: 'السحوبات', labelEn: 'Payouts', keys: ['payouts'], group: 'transactions' },
  { to: '/payout-requests', icon: '⚡', labelAr: 'طلبات السحب اليدوية', labelEn: 'Manual payout requests', keys: ['payouts'], group: 'transactions' },
  { to: '/transactions', icon: '📋', labelAr: 'كل المعاملات', labelEn: 'All transactions', keys: ['transactions', 'all_transactions', 'refunds', 'reversals'], group: 'transactions' },
  { to: '/admin-transactions', icon: '🧰', labelAr: 'معاملات الإدارة', labelEn: 'Admin Transactions', keys: ['transactions'], roles: TRANSACTION_ADMIN_ROLES, group: 'transactions' },
  { to: '/review', icon: '🧐', labelAr: 'مراجعة القرارات', labelEn: 'Decision review', keys: ['review', 'audit_log', 'audit-logs'], group: 'transactions' },
  { to: '/mismatch', icon: '🎯', labelAr: 'كشف عدم التطابق', labelEn: 'Mismatch detector', keys: ['review', 'audit_log', 'audit-logs', 'risk', 'risk_audit', 'compliance'], group: 'transactions' },
  { to: '/operations-archive', icon: '🗄️', labelAr: 'أرشيف العمليات', labelEn: 'Operations archive', keys: ['audit_log', 'audit-logs', 'transactions'], group: 'transactions' },
  { to: '/sms', icon: '📨', labelAr: 'SMS مباشر', labelEn: 'Live SMS', keys: ['sms_live'], group: 'payments' },
  { to: '/airdroid', icon: '📱', labelAr: 'إدارة AirDroid', labelEn: 'AirDroid devices', keys: ['sms_live', 'wallets'], group: 'payments' },
  { to: '/devices', icon: '📲', labelAr: 'أسطول الأجهزة', labelEn: 'Device fleet', keys: ['sms_live', 'wallets'], group: 'payments' },
  { to: '/wallet-report', icon: '📊', labelAr: 'تقرير المحافظ', labelEn: 'Wallet report', keys: ['sms_live', 'wallets'], group: 'payments' },
  { to: '/wallet-investigation', icon: '🔎', labelAr: 'تحقيق المحفظة', labelEn: 'Wallet investigation', keys: ['sms_live', 'wallets'], group: 'payments' },
  { to: '/withdrawal-sms-report', icon: '🧾', labelAr: 'تقرير SMS السحب', labelEn: 'Withdrawal SMS report', keys: ['reports', 'advanced_analysis', 'sms_live'], group: 'payments' },
  { to: '/wallet-movements', icon: '💱', labelAr: 'حركة المحافظ', labelEn: 'Wallet movements', keys: ['wallets', 'treasury', 'reports', 'sms_live'], group: 'payments' },
  { to: '/tv', icon: '🖥️', labelAr: 'شاشة TV', labelEn: 'TV screen', keys: ['sms_live'], group: 'overview' },
  { to: '/complaints', icon: '🛎️', labelAr: 'الشكاوى', labelEn: 'Complaints', keys: ['support'], roles: COMPLAINT_ROLES, group: 'customers' },
  { to: '/chat', icon: '💬', labelAr: 'محادثات الفريق', labelEn: 'Internal Chat', keys: [], group: 'customers' },
  { to: '/merchant-link-generator', icon: '🔗', labelAr: 'روابط الدفع', labelEn: 'Payment links', keys: ['checkout-builder'], group: 'payments' },
  // Management — merchants, wallets, money movement
  { to: '/merchants', icon: '🏬', labelAr: 'التجار', labelEn: 'Merchants', keys: ['merchants'], group: 'customers' },
  { to: '/wallets', icon: '👛', labelAr: 'المحافظ', labelEn: 'Wallets', keys: ['wallets'], group: 'payments' },
  { to: '/payment-methods', icon: '💳', labelAr: 'طرق الدفع', labelEn: 'Payment Methods', keys: ['wallets', 'payment_methods'], group: 'payments' },
  { to: '/merchant-payment-setup', icon: '🧩', labelAr: 'إعداد دفع التجار', labelEn: 'Merchant Payment Setup', keys: ['wallets', 'payment_methods'], group: 'payments' },
  { to: '/known-recipients', icon: '🎯', labelAr: 'المستلمون المعروفون', labelEn: 'Known Recipients', keys: ['wallets', 'payouts'], group: 'payments' },
  { to: '/ontarget-hub', icon: '🏛️', labelAr: 'مركز الخزينة', labelEn: 'Treasury Hub', keys: ['wallets', 'payouts', 'sms_live', 'treasury'], group: 'payments' },
  { to: '/crm', icon: '👥', labelAr: 'CRM العملاء', labelEn: 'Customer CRM', keys: ['client_crm'], group: 'customers' },
  { to: '/client', icon: '🗂️', labelAr: 'ملف عميل كامل', labelEn: 'Client profile', keys: ['client_crm'], group: 'customers' },
  { to: '/settlements', icon: '🧾', labelAr: 'التسويات', labelEn: 'Settlements', keys: ['settlements', 'settlements_list', 'settlement_recon', 'fees'], group: 'payments' },
  // Risk & automation
  { to: '/risk', icon: '🛡️', labelAr: 'المخاطر', labelEn: 'Risk & compliance', keys: ['risk', 'risk_audit', 'flagged', 'exceptions', 'manual_review', 'velocity', 'compliance'], group: 'automation' },
  { to: '/automation', icon: '🤖', labelAr: 'الأتمتة', labelEn: 'Automation', keys: ['automation', 'telegram_bot', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team'], group: 'automation' },
  { to: '/replay-lab', icon: '🧪', labelAr: 'مختبر Replay', labelEn: 'Replay lab', keys: ['automation', 'sms_live', 'webhooks'], group: 'automation' },
  { to: '/webhooks', icon: '↗', labelAr: 'مركز Webhooks', labelEn: 'Webhook Center', keys: ['webhooks', 'developers'], group: 'admin' },
  { to: '/telegram', icon: '✈️', labelAr: 'Telegram مباشر', labelEn: 'Telegram Live', keys: ['telegram_bot', 'automation'], group: 'automation' },
  { to: '/binance', icon: '🪙', labelAr: 'Binance P2P', labelEn: 'Binance P2P', keys: ['binance_p2p_config', 'binance_p2p', 'treasury'], group: 'automation' },
  { to: '/binance/p2p-ads', icon: '📣', labelAr: 'إعلانات P2P', labelEn: 'P2P Live Ads', keys: ['binance_p2p', 'treasury'], group: 'automation' },
  { to: '/binance/p2p-history', icon: '🧾', labelAr: 'سجل P2P', labelEn: 'P2P History', keys: ['binance_p2p', 'treasury'], group: 'automation' },
  // System — reporting, audit, admin
  { to: '/reports', icon: '📊', labelAr: 'التقارير الشاملة', labelEn: 'Full reports', keys: ['reports', 'advanced_analysis'], group: 'insights' },
  { to: '/audit', icon: '🕵️', labelAr: 'سجل التدقيق', labelEn: 'Audit log', keys: ['audit_log', 'audit-logs'], group: 'admin' },
  { to: '/notifications', icon: '🔔', labelAr: 'الإشعارات', labelEn: 'Notifications', keys: ['notifications'], group: 'admin' },
  { to: '/integration-guide', icon: '📘', labelAr: 'دليل ربط API', labelEn: 'API integration guide', keys: ['api-keys', 'settings', 'merchants'], group: 'admin' },
  // 'settings' alone is not enough here: 19 of 21 roles hold it, but the API
  // is behind requireAdminRole. Both conditions must hold for the link to draw.
  { to: '/admin/users', icon: '👥', labelAr: 'المستخدمون', labelEn: 'Users', keys: ['users', 'settings'], roles: ADMIN_ROLES, group: 'admin' },
  { to: '/admin/merchants/new', icon: '➕', labelAr: 'تاجر جديد', labelEn: 'New merchant', keys: ['merchants', 'settings'], roles: ADMIN_ROLES, group: 'admin' },
  { to: '/admin/logos', icon: '🎨', labelAr: 'الشعارات', labelEn: 'Logos', keys: ['settings'], roles: ADMIN_ROLES, group: 'admin' },
  { to: '/admin/permissions', icon: '🔐', labelAr: 'الصلاحيات', labelEn: 'Permissions', keys: ['permissions', 'settings'], roles: ADMIN_ROLES, group: 'admin' },
  { to: '/admin/fees', icon: '🪙', labelAr: 'الرسوم', labelEn: 'Fees', keys: ['fees', 'settings'], roles: ADMIN_ROLES, group: 'admin' },
  { to: '/admin/wallet-capacity', icon: '📊', labelAr: 'سعة المحافظ', labelEn: 'Wallet capacity', keys: ['wallets', 'settings'], roles: ADMIN_ROLES, group: 'admin' },
  { to: '/admin/api-keys', icon: '🔑', labelAr: 'مفاتيح API', labelEn: 'API keys', keys: ['api-keys', 'settings'], roles: ADMIN_ROLES, group: 'admin' },
]

// Every page_key now represented by a real page — the "قريباً" module list
// only shows keys not covered below.
const BUILT_PAGE_KEYS = new Set([
  'dashboard',
  'deposits', 'deposit-queue', 'pending_deposits',
  'payouts', 'pending_payouts',
  'transactions', 'all_transactions', 'refunds', 'reversals',
  'revenue_center',
  'approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me',
  'settlements', 'settlements_list', 'settlement_recon', 'fees',
  'merchants', 'merchant_detail', 'merchant-dashboard', 'master_merchants', 'sub_merchants', 'sub-merchants', 'agents',
  'wallets', 'wallet_pool', 'wallet-pools', 'accounts', 'payment_methods',
  'client_crm',
  'risk', 'risk_audit', 'flagged', 'exceptions', 'manual_review', 'velocity', 'compliance',
  'telegram_bot', 'binance_p2p_config', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team',
  'audit_log', 'audit-logs', 'review',
  'users', 'permissions', 'api-keys', 'webhooks', 'developers', 'settings',
  'reports', 'advanced_analysis',
  'support', 'notifications',
  'sms_live',
  'checkout-builder',
])

export interface PermittedModule {
  id: string
  label: string
  icon: string
  priority?: boolean
  pages: PagePermission[]
}

export function usePermittedModules(): PermittedModule[] {
  const { permissions } = useAuth()
  return useMemo(() => {
    const byCategory = new Map<string, PagePermission[]>()
    for (const p of permissions) {
      if (!p.can_view || BUILT_PAGE_KEYS.has(p.page_key)) continue
      const cat = categoryFor(p.page_key)
      if (!byCategory.has(cat)) byCategory.set(cat, [])
      byCategory.get(cat)!.push(p)
    }
    return CATEGORIES.filter((c) => byCategory.has(c.id)).map((c) => ({
      ...c,
      pages: byCategory.get(c.id)!,
    }))
  }, [permissions])
}

interface RailSms {
  id: number
  received_at: string | null
  device_name: string | null
  sim_slot: number | null
  sender_name: string | null
  sender_number: string | null
  amount: number | null
  sms_category: string | null
  matched: boolean | null
  match_status: string | null
  trx_id: string | null
  matched_tx_id?: number | null
  matched_ontarget_ref?: string | null
  linked_wallet_number?: string | null
  wallet_balance_after?: number | null
  sms_first_line?: string | null
  raw_sms?: string | null
  message?: string | null
}

interface RailDevice {
  device: string
  sim_slot: number | null
  online: boolean | null
  battery: number | null
  last_seen_at: string | null
}

interface RailTelegramAlert { id: number; alert_type: string; chat_id: string | null; message: string | null; ok: boolean | null; error: string | null; created_at: string | null }

const telegramPlainText = (value: string | null) => (value ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:b|code|strong|em)>/gi, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
const telegramTxRef = (value: string | null) => telegramPlainText(value).match(/(?:^|\n)TRX\s*:\s*([0-9]+)/i)?.[1] ?? null

function TelegramRail({ onMinimize }: { onMinimize: () => void }) {
  const { t } = useLocale()
  const [rows, setRows] = useState<RailTelegramAlert[]>([])
  useEffect(() => {
    let alive = true
    const load = () => void api<{ alerts: RailTelegramAlert[] }>('/api/telegram/live').then((result) => { if (alive) setRows(result.alerts ?? []) }).catch(() => {})
    load(); const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  return <aside id="live-telegram-widget" className="sms-rail telegram-rail" aria-label="Telegram Live" onPointerDown={(event) => event.stopPropagation()}>
    <div className="sms-rail-head"><span className="sms-rail-title telegram-live-title"><Send size={16}/>Telegram Live</span><span className="sms-rail-head-actions"><span className="live-dot"><span className="ld"/>{t('حي','Live')}</span><button type="button" className="sms-widget-icon-btn" onClick={onMinimize} aria-label={t('تصغير Telegram','Minimize Telegram')}><Minimize2 size={15}/></button></span></div>
    <div className="telegram-feed">
      {!rows.length && <span className="sidebar-hint">{t('لا توجد تنبيهات بعد.','No alerts yet.')}</span>}
      {rows.map((row) => {
        const ref = telegramTxRef(row.message)
        const body = <><div className="sms-feed-head"><span className="telegram-alert-type">{row.alert_type.replaceAll('_',' ')}</span><span className="sms-feed-time mono">{depositTime({ first_seen_at: row.created_at })}</span></div><div className="telegram-alert-message" dir="auto">{telegramPlainText(row.message) || '—'}</div><div className={`sms-feed-status ${row.ok ? 'link' : 'wait'}`}>{row.ok ? `✓ ${t('تم التسليم','Delivered')}` : `⚠ ${row.error ?? t('فشل التسليم','Delivery failed')}`}{row.chat_id && <span className="mono"> · {row.chat_id}</span>}</div></>
        return ref ? <Link key={row.id} to={`/transactions/${ref}`} className={`sms-feed-item telegram-feed-item${row.ok ? ' matched' : ''}`}>{body}</Link> : <article key={row.id} className={`sms-feed-item telegram-feed-item${row.ok ? ' matched' : ''}`}>{body}</article>
      })}
    </div>
  </aside>
}

function SmsRail({ onMinimize }: { onMinimize: () => void }) {
  const [rows, setRows] = useState<RailSms[]>([])
  const [devices, setDevices] = useState<RailDevice[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const sync = syncProviders()
        const [list, dev] = await Promise.all([
          api<{ rows: RailSms[] }>('/api/sms?limit=30'),
          api<{ devices: RailDevice[] }>('/api/sms/devices'),
        ])
        if (!alive) return
        setRows(list.rows)
        setDevices(dev.devices)
        if (await sync) {
          const [freshList, freshDev] = await Promise.all([
            api<{ rows: RailSms[] }>('/api/sms?limit=30'),
            api<{ devices: RailDevice[] }>('/api/sms/devices'),
          ])
          if (!alive) return
          setRows(freshList.rows)
          setDevices(freshDev.devices)
        }
      } catch {
        /* rail is best-effort */
      }
    }
    void load()
    const iv = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  return (
    <aside id="live-sms-widget" className="sms-rail" aria-label="Live SMS" onPointerDown={(event) => event.stopPropagation()}>
      <div className="sms-rail-head">
        <span className="sms-rail-title"><MessageSquareText size={16} aria-hidden="true" />SMS مباشر</span>
        <span className="sms-rail-head-actions"><span className="live-dot"><span className="ld" />حي</span><button type="button" className="sms-widget-icon-btn" onClick={onMinimize} aria-label="Minimize Live SMS" title="Minimize"><Minimize2 size={15} /></button></span>
      </div>
      {devices.length > 0 && (
        <div className="device-chips">
          {devices.map((d) => (
            <span key={`${d.device}#${d.sim_slot ?? 0}`} className={`device-chip ${d.online ? 'ok' : 'err'}`} title={d.battery != null ? `🔋${d.battery}%` : undefined}>
              <span className="dc" />{d.device}
            </span>
          ))}
        </div>
      )}
      <div className="sms-feed">
        {rows.length === 0 && <span className="sidebar-hint">لا توجد رسائل بعد.</span>}
        {rows.map((r) => {
          const walletLinked = r.sms_category === 'withdrawal' && r.linked_wallet_number != null
          const linked = walletLinked || r.matched_tx_id != null
          const rawText = r.raw_sms ?? r.message ?? r.sms_first_line
          return (
            <Link key={r.id} to={`/sms?sms_id=${r.id}`} className={`sms-feed-item${linked ? ' matched' : ''}${!linked && (r.sms_category === 'deposit' || r.sms_category === 'withdrawal') ? ' unlinked' : ''}${r.sms_category === 'withdrawal' ? ' withdrawal' : ''}`}>
              <div className="sms-feed-head">
                <span className="sms-feed-device">{r.device_name ?? '—'}{r.sim_slot != null && <> · SIM{r.sim_slot}</>}</span>
                <span className="sms-feed-time mono">{depositTime({ first_seen_at: r.received_at })}</span>
              </div>
              <div className="sms-feed-body">{r.sms_category === 'withdrawal' ? 'تحويل' : 'استلام'} {money(r.amount, 'EGP')}{' '}{r.sender_name ?? r.sender_number ? `— ${r.sender_name ?? r.sender_number}` : ''}</div>
              {rawText && <div className="sms-feed-raw" dir="auto">{rawText}</div>}
              {walletLinked && <div className="cell-sub mono">{r.linked_wallet_number} · رصيد {money(r.wallet_balance_after, 'EGP')}</div>}
              <div className={`sms-feed-status ${linked ? 'link' : r.sms_category === 'deposit' || r.sms_category === 'withdrawal' ? 'wait' : 'info'}`}>
                {walletLinked ? <>👛 محفظة <span className="mono">{r.linked_wallet_number}</span></> : linked ? <>🔗 مرتبطة <span className="mono">{r.matched_ontarget_ref ?? r.matched_tx_id}</span></> : r.sms_category === 'deposit' ? '⏳ بانتظار مطابقة' : r.sms_category === 'withdrawal' ? '⚠ محفظة غير معروفة' : 'غير مالية'}
              </div>
            </Link>
          )
        })}
      </div>
    </aside>
  )
}

export default function PanelShell({ children }: { children: ReactNode }) {
  const { permissions, can, refreshPermissions, user } = useAuth()
  const { locale, t } = useLocale()
  const { pathname } = useLocation()
  const activeGroup = BUILT_LINKS.find((link) => link.to === pathname)?.group ?? 'overview'
  const modules = usePermittedModules()
  const permsLoaded = permissions.length > 0
  const [navOpen, setNavOpen] = useState(false)
  const [navQuery, setNavQuery] = useState('')
  const [navPinned, setNavPinned] = useState(() => {
    try { return window.localStorage.getItem('ontarget:nav-pinned') === 'true' }
    catch { return false }
  })
  const [smsOpen, setSmsOpen] = useState(() => {
    try { return window.localStorage.getItem('ontarget:sms-widget') === 'expanded' }
    catch { return false }
  })
  const [telegramOpen, setTelegramOpen] = useState(false)
  const [smsUnread, setSmsUnread] = useState(0)
  const [smsUnlinked, setSmsUnlinked] = useState(0)
  const [telegramUnread, setTelegramUnread] = useState(0)
  const smsLatestRef = useRef(0)
  const telegramLatestRef = useRef(0)
  const [chatUnread, setChatUnread] = useState(0)
  const chatSeenRef = useRef<number | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<NavGroupId>>(() => new Set(NAV_GROUPS.map((group) => group.id).filter((id) => id !== activeGroup)))

  // Refresh the role permission matrix from role_page_permissions on each
  // page visit so button visibility follows the current authenticated role.
  useEffect(() => { void refreshPermissions() }, [pathname, refreshPermissions])

  // Internal chat uses the familiar SMS tone. The first response only sets a
  // baseline, so opening or refreshing the panel never creates a false alert.
  useEffect(() => {
    installNotificationAudioUnlock()
    const check = () => void api<{ rooms?: { unread?: number }[] }>('/api/chat').then((next) => {
      const unread = (next.rooms ?? []).reduce((sum, room) => sum + Number(room.unread ?? 0), 0)
      if (chatSeenRef.current !== null && unread > chatSeenRef.current && pathname !== '/chat') playNotificationTone('sms')
      chatSeenRef.current = unread
      setChatUnread(unread)
      window.dispatchEvent(new CustomEvent('ontarget:chat-unread', { detail: unread }))
    }).catch(() => {})
    check(); const timer = setInterval(check, 6000)
    return () => clearInterval(timer)
  }, [pathname])

  const canTelegramLive = COMPLAINT_ROLES.includes(user?.role ?? '')

  // Persistent unread markers make alerts visible even if they land while a
  // floating rail is minimized. The first successful read establishes a
  // baseline; opening the rail marks everything currently visible as seen.
  useEffect(() => {
    if (!user?.id) return
    let alive = true
    const smsKey = `ontarget:${user.id}:sms-last-seen`
    const telegramKey = `ontarget:${user.id}:telegram-last-seen`
    const update = async () => {
      const jobs: Promise<void>[] = []
      if (can('sms_live')) jobs.push(api<{ rows?: RailSms[] }>('/api/sms?limit=30').then(({ rows: responseRows = [] }) => {
        if (!alive) return
        const rows = Array.isArray(responseRows) ? responseRows : []
        const latest = Math.max(0, ...rows.map((row) => Number(row.id) || 0)); smsLatestRef.current = latest
        const stored = localStorage.getItem(smsKey)
        if (stored == null) { localStorage.setItem(smsKey, String(latest)); setSmsUnread(0) }
        else setSmsUnread(rows.filter((row) => Number(row.id) > Number(stored)).length)
        setSmsUnlinked(rows.filter((row) => row.sms_category === 'deposit' && row.matched_tx_id == null).length)
      }).catch(() => {}))
      if (canTelegramLive) jobs.push(api<{ alerts?: RailTelegramAlert[] }>('/api/telegram/live').then(({ alerts = [] }) => {
        if (!alive) return
        const latest = Math.max(0, ...alerts.map((row) => Number(row.id) || 0)); telegramLatestRef.current = latest
        const stored = localStorage.getItem(telegramKey)
        if (stored == null) { localStorage.setItem(telegramKey, String(latest)); setTelegramUnread(0) }
        else setTelegramUnread(alerts.filter((row) => Number(row.id) > Number(stored)).length)
      }).catch(() => {}))
      await Promise.all(jobs)
    }
    void update(); const timer = window.setInterval(update, 6_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [can, canTelegramLive, user?.id])

  const openSms = () => {
    if (user?.id) localStorage.setItem(`ontarget:${user.id}:sms-last-seen`, String(smsLatestRef.current))
    setSmsUnread(0); setSmsOpen(true); setTelegramOpen(false)
  }
  const openTelegram = () => {
    if (user?.id) localStorage.setItem(`ontarget:${user.id}:telegram-last-seen`, String(telegramLatestRef.current))
    setTelegramUnread(0); setTelegramOpen(true); setSmsOpen(false)
  }

  // The feed is a floating widget, compact by default. It auto-minimizes after
  // a short idle period so dense operations tables always retain full width.
  useEffect(() => {
    setSmsOpen(false)
    setTelegramOpen(false)
  }, [pathname])

  useEffect(() => {
    try { window.localStorage.setItem('ontarget:sms-widget', smsOpen ? 'expanded' : 'compact') } catch { /* optional preference */ }
    if (!smsOpen) return
    const timer = window.setTimeout(() => setSmsOpen(false), 30_000)
    return () => window.clearTimeout(timer)
  }, [smsOpen])

  useEffect(() => {
    try { window.localStorage.setItem('ontarget:nav-pinned', String(navPinned)) } catch { /* optional preference */ }
  }, [navPinned])

  // Keep the active category open and collapse the rest. This makes the long
  // operations menu scannable while preserving one-click access to every
  // section through its category header.
  useEffect(() => {
    setCollapsedGroups(new Set(NAV_GROUPS.map((group) => group.id).filter((id) => id !== activeGroup)))
  }, [activeGroup])

  // A link draws only when the role satisfies BOTH gates the server applies:
  // can_view on one of the page keys, and — where the API is role-gated — the
  // role itself. Hiding is presentation only; server/rbac.ts still refuses a
  // direct URL hit.
  const visible = (l: NavLinkDef) =>
    (l.keys.length === 0 || l.keys.some((k) => can(k))) &&
    (!l.roles || l.roles.includes(user?.role ?? ''))
  const normalizedNavQuery = navQuery.trim().toLocaleLowerCase()
  const matchesNavQuery = (link: NavLinkDef) => !normalizedNavQuery || `${link.labelEn} ${link.labelAr} ${link.to}`.toLocaleLowerCase().includes(normalizedNavQuery)
  const renderLinks = (group: NavGroupId) => BUILT_LINKS.filter((l) => l.group === group && visible(l) && matchesNavQuery(l)).map((l) => (
    <Link key={l.to} to={l.to} title={locale === 'en' ? l.labelEn : l.labelAr} onClick={() => setNavOpen(false)} className={`sidebar-item sidebar-link${pathname === l.to ? ' active' : ''}`}>
      <span className="sidebar-icon" aria-hidden="true">{l.icon}</span><span>{locale === 'en' ? l.labelEn : l.labelAr}</span>{l.to === '/chat' && chatUnread > 0 && <span className="sidebar-chat-badge" aria-label={`${chatUnread} unread`}>{chatUnread > 99 ? '99+' : chatUnread}</span>}
    </Link>
  ))
  const toggleGroup = (group: NavGroupId) => setCollapsedGroups((current) => {
    const next = new Set(current)
    if (next.has(group)) next.delete(group); else next.add(group)
    return next
  })

  return (
    <div className="dash-body">
      <a className="skip-link" href="#main-workspace">{t('تجاوز القائمة', 'Skip navigation')}</a>
      <button className="nav-toggle" onClick={() => setNavOpen((o) => !o)} title={t('القائمة', 'Menu')} aria-label={t('القائمة', 'Menu')}>{navOpen ? <X size={20} /> : <Menu size={20} />}</button>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <nav className={`sidebar${navOpen ? ' open' : ''}${navPinned ? ' pinned' : ''}`} aria-label={t('التنقل الرئيسي', 'Main navigation')}>
        <div className="sidebar-tools">
          <div className="sidebar-search-wrap">
            <Search size={15} aria-hidden="true" />
            <input value={navQuery} onChange={(event) => setNavQuery(event.target.value)} placeholder={t('بحث في الصفحات…', 'Search pages…')} aria-label={t('بحث في الصفحات', 'Search pages')} />
            {navQuery && <button type="button" onClick={() => setNavQuery('')} aria-label={t('مسح البحث', 'Clear search')}><X size={14} /></button>}
          </div>
          <button type="button" className="sidebar-pin" onClick={() => setNavPinned((value) => !value)} aria-pressed={navPinned} title={navPinned ? t('تصغير تلقائي', 'Auto minimize') : t('تثبيت القائمة', 'Pin sidebar')} aria-label={navPinned ? t('تصغير تلقائي', 'Auto minimize') : t('تثبيت القائمة', 'Pin sidebar')}>{navPinned ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
        </div>
        {NAV_GROUPS.map((g) => {
          const links = renderLinks(g.id)
          if (links.length === 0) return null
          const collapsed = collapsedGroups.has(g.id)
          return (
            <div className={`nav-group${collapsed ? ' collapsed' : ''}`} key={g.id}>
              <button type="button" className="nav-group-label" onClick={() => toggleGroup(g.id)} aria-expanded={!collapsed} title={locale === 'en' ? g.en : g.ar}>
                <span className="nav-group-title"><span className="nav-group-icon" aria-hidden="true">{NAV_GROUP_ICONS[g.id]}</span><span className="nav-group-name">{locale === 'en' ? g.en : g.ar}</span></span><ChevronDown className="nav-group-chevron" size={15} aria-hidden="true" />
              </button>
              <div className="nav-group-links">{links}</div>
            </div>
          )
        })}
        {!permsLoaded && <div className="sidebar-hint">{t('جارٍ تحميل الصلاحيات…', 'Loading permissions…')}</div>}
        {modules.length > 0 && <div className="nav-group">
          <div className="nav-group-label">{t('قريباً', 'More modules')}</div>
          {modules.map((m) => <div key={m.id} className="sidebar-item soon" title={t('قريباً', 'More modules')}><span className="sidebar-icon">{m.icon}</span><span>{m.label}</span><span className="sidebar-count">{m.pages.length}</span></div>)}
        </div>}
        {normalizedNavQuery && NAV_GROUPS.every((group) => renderLinks(group.id).length === 0) && <div className="sidebar-empty">{t('لا توجد صفحة مطابقة.', 'No matching page.')}</div>}
      </nav>
      <main id="main-workspace" className="dash-main">{children}</main>
      {canTelegramLive && !telegramOpen && <button type="button" className={`telegram-widget-launcher${telegramUnread ? ' has-unread' : ''}`} onClick={openTelegram} aria-expanded="false" aria-controls="live-telegram-widget" aria-label={t('إظهار Telegram المباشر', 'Show Telegram Live')} title={t('إظهار Telegram المباشر', 'Show Telegram Live')}><span className="telegram-widget-pulse"/><Send size={19} aria-hidden="true"/><span className="sms-widget-label">Telegram Live</span>{telegramUnread > 0 && <span className="live-widget-badge">{telegramUnread > 99 ? '99+' : telegramUnread}</span>}</button>}
      {can('sms_live') && !smsOpen && <button type="button" className={`sms-widget-launcher${smsUnread ? ' has-unread' : ''}${smsUnlinked ? ' has-unlinked' : ''}`} onClick={openSms} aria-expanded="false" aria-controls="live-sms-widget" aria-label={t('إظهار SMS المباشر', 'Show Live SMS')} title={t('إظهار SMS المباشر', 'Show Live SMS')}><span className="sms-widget-pulse" /><MessageSquareText size={20} aria-hidden="true" /><span className="sms-widget-label">Live SMS</span>{(smsUnread > 0 || smsUnlinked > 0) && <span className={`live-widget-badge${smsUnlinked ? ' unlinked-badge' : ''}`}>{smsUnlinked > 99 ? '99+' : smsUnlinked || smsUnread}</span>}</button>}
      {can('sms_live') && smsOpen && <SmsRail onMinimize={() => setSmsOpen(false)} />}
      {canTelegramLive && telegramOpen && <TelegramRail onMinimize={() => setTelegramOpen(false)} />}
    </div>
  )
}
