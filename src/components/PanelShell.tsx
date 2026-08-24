import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { CATEGORIES, categoryFor } from '../nav/pageCatalog'
import { api } from '../lib/api'
import { syncProviders } from '../lib/providerSync'
import { depositTime, money } from '../lib/deposits'
import type { PagePermission } from '../lib/api'
import { useLocale } from '../lib/locale'

// Shared authed layout ("Live Transaction Monitor" skin): nav rail (real pages
// first, then the role's remaining permitted modules as "قريباً" placeholders),
// main content, and an always-on live SMS rail for roles with sms_live access.

type NavGroupId = 'main' | 'operations' | 'management' | 'risk' | 'system'

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
// Mirrors the ALLOWED set in server/complaints.ts, which is also role-gated
// rather than permission-gated — every role holds can_view on 'support', so
// the key alone would keep showing the link to the 16 roles the API refuses.
const COMPLAINT_ROLES = ['owner', 'admin', 'super_admin', 'operator', 'operations_admin']

// Ordered nav groups. Only groups with at least one visible link render.
const NAV_GROUPS: { id: NavGroupId; ar: string; en: string }[] = [
  { id: 'main', ar: 'رئيسية', en: 'Main' },
  { id: 'operations', ar: 'العمليات', en: 'Operations' },
  { id: 'management', ar: 'الإدارة والتجار', en: 'Management' },
  { id: 'risk', ar: 'المخاطر والأتمتة', en: 'Risk & automation' },
  { id: 'system', ar: 'النظام', en: 'System' },
]

const BUILT_LINKS: NavLinkDef[] = [
  // Main — dashboards & live monitoring
  { to: '/', icon: '🏠', labelAr: 'لوحة التحكم', labelEn: 'Dashboard', keys: ['dashboard'], group: 'main' },
  { to: '/control-room', icon: '🎛️', labelAr: 'غرفة التحكم', labelEn: 'Control room', keys: ['dashboard'], group: 'main' },
  { to: '/monitor', icon: '📡', labelAr: 'المراقبة المباشرة', labelEn: 'Live Monitor', keys: ['dashboard'], group: 'main' },
  { to: '/executive-dashboard', icon: '▦', labelAr: 'لوحة الإدارة التنفيذية', labelEn: 'Executive Dashboard', keys: ['dashboard', 'reports', 'advanced_analysis', 'treasury', 'wallets'], group: 'main' },
  { to: '/analytics-dashboard', icon: '◫', labelAr: 'لوحة التحليلات', labelEn: 'Analytics Dashboard', keys: ['dashboard', 'reports', 'advanced_analysis', 'wallets'], group: 'main' },
  { to: '/system-health', icon: '♥', labelAr: 'حالة النظام', labelEn: 'System Health', keys: ['dashboard', 'automation', 'audit'], group: 'main' },
  { to: '/performance', icon: '📈', labelAr: 'أداء المزوّدين والتجار', labelEn: 'Provider & merchant performance', keys: ['reports', 'analytics', 'dashboard', 'transactions', 'merchants'], group: 'main' },
  // Operations — the daily transaction workflow
  { to: '/approvals', icon: '✅', labelAr: 'طابور الموافقات', labelEn: 'Approval queue', keys: ['approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me'], group: 'operations' },
  { to: '/deposits', icon: '💰', labelAr: 'الإيداعات', labelEn: 'Deposits', keys: ['deposits'], group: 'operations' },
  { to: '/payouts', icon: '📤', labelAr: 'السحوبات', labelEn: 'Payouts', keys: ['payouts'], group: 'operations' },
  { to: '/transactions', icon: '📋', labelAr: 'كل المعاملات', labelEn: 'All transactions', keys: ['transactions', 'all_transactions', 'refunds', 'reversals'], group: 'operations' },
  { to: '/review', icon: '🧐', labelAr: 'مراجعة القرارات', labelEn: 'Decision review', keys: ['review', 'audit_log', 'audit-logs'], group: 'operations' },
  { to: '/mismatch', icon: '🎯', labelAr: 'كشف عدم التطابق', labelEn: 'Mismatch detector', keys: ['review', 'audit_log', 'audit-logs', 'risk', 'risk_audit', 'compliance'], group: 'operations' },
  { to: '/operations-archive', icon: '🗄️', labelAr: 'أرشيف العمليات', labelEn: 'Operations archive', keys: ['audit_log', 'audit-logs', 'transactions'], group: 'operations' },
  { to: '/sms', icon: '📨', labelAr: 'SMS مباشر', labelEn: 'Live SMS', keys: ['sms_live'], group: 'operations' },
  { to: '/airdroid', icon: '📱', labelAr: 'إدارة AirDroid', labelEn: 'AirDroid devices', keys: ['sms_live', 'wallets'], group: 'operations' },
  { to: '/wallet-report', icon: '📊', labelAr: 'تقرير المحافظ', labelEn: 'Wallet report', keys: ['sms_live', 'wallets'], group: 'operations' },
  { to: '/wallet-movements', icon: '💱', labelAr: 'حركة المحافظ', labelEn: 'Wallet movements', keys: ['wallets', 'treasury', 'reports', 'sms_live'], group: 'operations' },
  { to: '/tv', icon: '🖥️', labelAr: 'شاشة TV', labelEn: 'TV screen', keys: ['sms_live'], group: 'operations' },
  { to: '/complaints', icon: '🛎️', labelAr: 'الشكاوى', labelEn: 'Complaints', keys: ['support'], roles: COMPLAINT_ROLES, group: 'operations' },
  { to: '/merchant-link-generator', icon: '🔗', labelAr: 'روابط الدفع', labelEn: 'Payment links', keys: ['checkout-builder'], group: 'operations' },
  // Management — merchants, wallets, money movement
  { to: '/merchants', icon: '🏬', labelAr: 'التجار', labelEn: 'Merchants', keys: ['merchants'], group: 'management' },
  { to: '/wallets', icon: '👛', labelAr: 'المحافظ', labelEn: 'Wallets', keys: ['wallets'], group: 'management' },
  { to: '/payment-methods', icon: '💳', labelAr: 'طرق الدفع', labelEn: 'Payment Methods', keys: ['wallets', 'payment_methods'], group: 'management' },
  { to: '/known-recipients', icon: '🎯', labelAr: 'المستلمون المعروفون', labelEn: 'Known Recipients', keys: ['wallets', 'payouts'], group: 'management' },
  { to: '/ontarget-hub', icon: '🏛️', labelAr: 'مركز الخزينة', labelEn: 'Treasury Hub', keys: ['wallets', 'payouts', 'sms_live', 'treasury'], group: 'management' },
  { to: '/crm', icon: '👥', labelAr: 'CRM العملاء', labelEn: 'Customer CRM', keys: ['client_crm'], group: 'management' },
  { to: '/client', icon: '🗂️', labelAr: 'ملف عميل كامل', labelEn: 'Client profile', keys: ['client_crm'], group: 'management' },
  { to: '/settlements', icon: '🧾', labelAr: 'التسويات', labelEn: 'Settlements', keys: ['settlements', 'settlements_list', 'settlement_recon', 'fees'], group: 'management' },
  // Risk & automation
  { to: '/risk', icon: '🛡️', labelAr: 'المخاطر', labelEn: 'Risk & compliance', keys: ['risk', 'risk_audit', 'flagged', 'exceptions', 'manual_review', 'velocity', 'compliance'], group: 'risk' },
  { to: '/automation', icon: '🤖', labelAr: 'الأتمتة', labelEn: 'Automation', keys: ['automation', 'telegram_bot', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team'], group: 'risk' },
  { to: '/replay-lab', icon: '🧪', labelAr: 'مختبر Replay', labelEn: 'Replay lab', keys: ['automation', 'sms_live', 'webhooks'], group: 'risk' },
  { to: '/telegram', icon: '📨', labelAr: 'تنبيهات Telegram', labelEn: 'Telegram alerts', keys: ['telegram_bot', 'automation'], group: 'risk' },
  { to: '/binance', icon: '🪙', labelAr: 'خزينة USDT', labelEn: 'USDT Treasury', keys: ['binance_p2p', 'treasury'], group: 'risk' },
  // System — reporting, audit, admin
  { to: '/reports', icon: '📊', labelAr: 'التقارير الشاملة', labelEn: 'Full reports', keys: ['reports', 'advanced_analysis'], group: 'system' },
  { to: '/audit', icon: '🕵️', labelAr: 'سجل التدقيق', labelEn: 'Audit log', keys: ['audit_log', 'audit-logs'], group: 'system' },
  { to: '/notifications', icon: '🔔', labelAr: 'الإشعارات', labelEn: 'Notifications', keys: ['notifications'], group: 'system' },
  // 'settings' alone is not enough here: 19 of 21 roles hold it, but the API
  // is behind requireAdminRole. Both conditions must hold for the link to draw.
  { to: '/admin', icon: '⚙️', labelAr: 'الإدارة', labelEn: 'Administration', keys: ['users', 'permissions', 'api-keys', 'webhooks', 'developers', 'settings'], roles: ADMIN_ROLES, group: 'system' },
]

// Every page_key now represented by a real page — the "قريباً" module list
// only shows keys not covered below.
const BUILT_PAGE_KEYS = new Set([
  'dashboard',
  'deposits', 'deposit-queue', 'pending_deposits',
  'payouts', 'pending_payouts',
  'transactions', 'all_transactions', 'refunds', 'reversals',
  'approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me',
  'settlements', 'settlements_list', 'settlement_recon', 'fees',
  'merchants', 'merchant_detail', 'merchant-dashboard', 'master_merchants', 'sub_merchants', 'sub-merchants', 'agents',
  'wallets', 'wallet_pool', 'wallet-pools', 'accounts', 'payment_methods',
  'client_crm',
  'risk', 'risk_audit', 'flagged', 'exceptions', 'manual_review', 'velocity', 'compliance',
  'telegram_bot', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team',
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
}

interface RailDevice {
  device: string
  sim_slot: number | null
  online: boolean | null
  battery: number | null
  last_seen_at: string | null
}

function SmsRail() {
  const [rows, setRows] = useState<RailSms[]>([])
  const [devices, setDevices] = useState<RailDevice[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        await syncProviders()
        const [list, dev] = await Promise.all([
          api<{ rows: RailSms[] }>('/api/sms?limit=8'),
          api<{ devices: RailDevice[] }>('/api/sms/devices'),
        ])
        if (!alive) return
        setRows(list.rows)
        setDevices(dev.devices)
      } catch {
        /* rail is best-effort */
      }
    }
    void load()
    const iv = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  return (
    <aside className="sms-rail">
      <div className="sms-rail-head">
        <span className="sms-rail-title">📨 SMS مباشر</span>
        <span className="live-dot"><span className="ld" />حي</span>
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
          return (
            <Link key={r.id} to="/sms" className={`sms-feed-item${linked ? ' matched' : ''}${r.sms_category === 'withdrawal' ? ' withdrawal' : ''}`}>
              <div className="sms-feed-head">
                <span className="sms-feed-device">{r.device_name ?? '—'}{r.sim_slot != null && <> · SIM{r.sim_slot}</>}</span>
                <span className="sms-feed-time mono">{depositTime({ first_seen_at: r.received_at })}</span>
              </div>
              <div className="sms-feed-body">{r.sms_category === 'withdrawal' ? 'تحويل' : 'استلام'} {money(r.amount, 'EGP')}{' '}{r.sender_name ?? r.sender_number ? `— ${r.sender_name ?? r.sender_number}` : ''}</div>
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
  const modules = usePermittedModules()
  const permsLoaded = permissions.length > 0
  const [navOpen, setNavOpen] = useState(false)
  const [smsOpen, setSmsOpen] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<NavGroupId>>(() => new Set())

  // Refresh the role permission matrix from role_page_permissions on each
  // page visit so button visibility follows the current authenticated role.
  useEffect(() => { void refreshPermissions() }, [pathname, refreshPermissions])

  // A link draws only when the role satisfies BOTH gates the server applies:
  // can_view on one of the page keys, and — where the API is role-gated — the
  // role itself. Hiding is presentation only; server/rbac.ts still refuses a
  // direct URL hit.
  const visible = (l: NavLinkDef) =>
    (l.keys.length === 0 || l.keys.some((k) => can(k))) &&
    (!l.roles || l.roles.includes(user?.role ?? ''))
  const renderLinks = (group: NavGroupId) => BUILT_LINKS.filter((l) => l.group === group && visible(l)).map((l) => (
    <Link key={l.to} to={l.to} title={locale === 'en' ? l.labelEn : l.labelAr} onClick={() => setNavOpen(false)} className={`sidebar-item sidebar-link${pathname === l.to ? ' active' : ''}`}>
      <span className="sidebar-icon">{l.icon}</span><span>{locale === 'en' ? l.labelEn : l.labelAr}</span>
    </Link>
  ))
  const toggleGroup = (group: NavGroupId) => setCollapsedGroups((current) => {
    const next = new Set(current)
    if (next.has(group)) next.delete(group); else next.add(group)
    return next
  })

  return (
    <div className="dash-body">
      <button className="nav-toggle" onClick={() => setNavOpen((o) => !o)} title={t('القائمة', 'Menu')} aria-label={t('القائمة', 'Menu')}>{navOpen ? '✕' : '☰'}</button>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <nav className={`sidebar${navOpen ? ' open' : ''}`}>
        {NAV_GROUPS.map((g) => {
          const links = renderLinks(g.id)
          if (links.length === 0) return null
          const collapsed = collapsedGroups.has(g.id)
          return (
            <div className={`nav-group${collapsed ? ' collapsed' : ''}`} key={g.id}>
              <button type="button" className="nav-group-label" onClick={() => toggleGroup(g.id)} aria-expanded={!collapsed} title={locale === 'en' ? g.en : g.ar}>
                <span>{locale === 'en' ? g.en : g.ar}</span><span className="nav-group-chevron" aria-hidden="true">⌄</span>
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
      </nav>
      <main className="dash-main">{children}</main>
      {can('sms_live') && <button type="button" className="btn-ghost btn-sm" style={{ position: 'fixed', insetInlineEnd: 12, bottom: 12, zIndex: 30 }} onClick={() => setSmsOpen((open) => !open)} aria-pressed={smsOpen}>{smsOpen ? t('إخفاء SMS المباشر', 'Hide Live SMS') : t('إظهار SMS المباشر', 'Show Live SMS')}</button>}
      {can('sms_live') && smsOpen && <SmsRail />}
    </div>
  )
}
