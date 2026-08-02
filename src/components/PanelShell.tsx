import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { CATEGORIES, categoryFor } from '../nav/pageCatalog'
import { api } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import type { PagePermission } from '../lib/api'
import { useLocale } from '../lib/locale'

// Shared authed layout ("Live Transaction Monitor" skin): nav rail (real pages
// first, then the role's remaining permitted modules as "قريباً" placeholders),
// main content, and an always-on live SMS rail for roles with sms_live access.

interface NavLinkDef {
  to: string
  icon: string
  labelAr: string
  labelEn: string
  /** visible when the role can_view ANY of these keys; empty = always */
  keys: string[]
  group: 'main' | 'system'
}

const BUILT_LINKS: NavLinkDef[] = [
  { to: '/', icon: '🏠', labelAr: 'لوحة التحكم', labelEn: 'Dashboard', keys: [], group: 'main' },
  { to: '/monitor', icon: '📡', labelAr: 'المراقبة المباشرة', labelEn: 'Live Monitor', keys: [], group: 'main' },
  { to: '/approvals', icon: '✅', labelAr: 'طابور الموافقات', labelEn: 'Approval queue', keys: ['approvals', 'approval-queue', 'my-queue', 'my-tasks', 'assigned_to_me'], group: 'main' },
  { to: '/deposits', icon: '💰', labelAr: 'الإيداعات', labelEn: 'Deposits', keys: ['deposits'], group: 'main' },
  { to: '/payouts', icon: '📤', labelAr: 'السحوبات', labelEn: 'Payouts', keys: ['payouts'], group: 'main' },
  { to: '/transactions', icon: '📋', labelAr: 'كل المعاملات', labelEn: 'All transactions', keys: ['transactions', 'all_transactions', 'refunds', 'reversals'], group: 'main' },
  { to: '/sms', icon: '📨', labelAr: 'SMS مباشر', labelEn: 'Live SMS', keys: ['sms_live'], group: 'main' },
  { to: '/tv', icon: '🖥️', labelAr: 'شاشة TV', labelEn: 'TV screen', keys: ['sms_live'], group: 'main' },
  { to: '/complaints', icon: '🛎️', labelAr: 'الشكاوى', labelEn: 'Complaints', keys: [], group: 'main' },
  { to: '/merchant-link-generator', icon: '🔗', labelAr: 'روابط الدفع', labelEn: 'Payment links', keys: ['checkout-builder'], group: 'main' },
  { to: '/merchants', icon: '🏬', labelAr: 'التجار', labelEn: 'Merchants', keys: ['merchants'], group: 'system' },
  { to: '/wallets', icon: '👛', labelAr: 'المحافظ', labelEn: 'Wallets', keys: ['wallets'], group: 'system' },
  { to: '/crm', icon: '👥', labelAr: 'CRM العملاء', labelEn: 'Customer CRM', keys: ['client_crm'], group: 'system' },
  { to: '/settlements', icon: '🧾', labelAr: 'التسويات', labelEn: 'Settlements', keys: ['settlements', 'settlements_list', 'settlement_recon', 'fees'], group: 'system' },
  { to: '/risk', icon: '🛡️', labelAr: 'المخاطر', labelEn: 'Risk & compliance', keys: ['risk', 'risk_audit', 'flagged', 'exceptions', 'manual_review', 'velocity', 'compliance'], group: 'system' },
  { to: '/automation', icon: '🤖', labelAr: 'الأتمتة', labelEn: 'Automation', keys: ['telegram_bot', 'binance_p2p', 'treasury', 'allocation_engine', 'capacity_monitor', 'workspace_hub', 'launchpad', 'ai_team'], group: 'system' },
  { to: '/reports', icon: '📊', labelAr: 'التقارير', labelEn: 'Reports', keys: ['reports', 'advanced_analysis'], group: 'system' },
  { to: '/audit', icon: '🕵️', labelAr: 'سجل التدقيق', labelEn: 'Audit log', keys: ['audit_log', 'audit-logs'], group: 'system' },
  { to: '/notifications', icon: '🔔', labelAr: 'الإشعارات', labelEn: 'Notifications', keys: [], group: 'system' },
  { to: '/admin', icon: '⚙️', labelAr: 'الإدارة', labelEn: 'Administration', keys: ['users', 'permissions', 'api-keys', 'webhooks', 'developers', 'settings'], group: 'system' },
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
  'audit_log', 'audit-logs',
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
        // Fire-and-forget: keeps panel-v2 topped up from the old prod DB
        // while anyone has the panel open (server throttles to 1/min).
        void fetch('/api/cron/delta-sync', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
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
    const iv = setInterval(load, 20_000)
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
            <span
              key={`${d.device}#${d.sim_slot ?? 0}`}
              className={`device-chip ${d.online ? 'ok' : 'err'}`}
              title={d.battery != null ? `🔋${d.battery}%` : undefined}
            >
              <span className="dc" />{d.device}
            </span>
          ))}
        </div>
      )}
      <div className="sms-feed">
        {rows.length === 0 && <span className="sidebar-hint">لا توجد رسائل بعد.</span>}
        {rows.map((r) => {
          const linked = r.matched || (r.match_status && r.match_status !== 'unmatched')
          return (
            <Link key={r.id} to="/sms" className={`sms-feed-item${linked ? ' matched' : ''}`}>
              <div className="sms-feed-head">
                <span className="sms-feed-device">
                  {r.device_name ?? '—'}{r.sim_slot != null && <> · SIM{r.sim_slot}</>}
                </span>
                <span className="sms-feed-time mono">{depositTime({ first_seen_at: r.received_at })}</span>
              </div>
              <div className="sms-feed-body">
                {r.sms_category === 'withdrawal' ? 'تحويل' : 'استلام'} {money(r.amount, 'EGP')}
                {' '}{r.sender_name ?? r.sender_number ? `— ${r.sender_name ?? r.sender_number}` : ''}
              </div>
              <div className={`sms-feed-status ${linked ? 'link' : r.sms_category === 'deposit' || r.sms_category === 'withdrawal' ? 'wait' : 'info'}`}>
                {linked
                  ? <>🔗 مرتبطة{r.trx_id && <span className="mono"> {r.trx_id}</span>}</>
                  : r.sms_category === 'deposit' || r.sms_category === 'withdrawal'
                    ? '⏳ بانتظار مطابقة'
                    : 'غير مالية'}
              </div>
            </Link>
          )
        })}
      </div>
    </aside>
  )
}

export default function PanelShell({ children }: { children: ReactNode }) {
  const { permissions, can } = useAuth()
  const { locale, t } = useLocale()
  const { pathname } = useLocation()
  const modules = usePermittedModules()
  const permsLoaded = permissions.length > 0
  const [navOpen, setNavOpen] = useState(false)

  const visible = (l: NavLinkDef) => l.keys.length === 0 || l.keys.some((k) => can(k))
  const renderLinks = (group: 'main' | 'system') =>
    BUILT_LINKS.filter((l) => l.group === group && visible(l)).map((l) => (
      <Link
        key={l.to}
        to={l.to}
        onClick={() => setNavOpen(false)}
        className={`sidebar-item sidebar-link${pathname === l.to ? ' active' : ''}`}
      >
        <span className="sidebar-icon">{l.icon}</span>
        <span>{locale === 'en' ? l.labelEn : l.labelAr}</span>
      </Link>
    ))

  return (
    <div className="dash-body">
      <button className="nav-toggle" onClick={() => setNavOpen((o) => !o)} title={t("القائمة", "Menu")} aria-label={t("القائمة", "Menu")}>
        {navOpen ? '✕' : '☰'}
      </button>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <nav className={`sidebar${navOpen ? ' open' : ''}`}>
        <div className="nav-group-label">{t('القائمة الرئيسية', 'Main navigation')}</div>
        {renderLinks('main')}
        <div className="nav-group-label">{t('النظام', 'System')}</div>
        {renderLinks('system')}
        {!permsLoaded && <div className="sidebar-hint">{t('جارٍ تحميل الصلاحيات…', 'Loading permissions…')}</div>}
        {modules.length > 0 && <div className="nav-group-label">{t('قريباً', 'More modules')}</div>}
        {modules.map((m) => (
          <div key={m.id} className="sidebar-item soon" title={t("قريباً", "More modules")}>
            <span className="sidebar-icon">{m.icon}</span>
            <span>{m.label}</span>
            <span className="sidebar-count">{m.pages.length}</span>
          </div>
        ))}
      </nav>
      <main className="dash-main">{children}</main>
      {can('sms_live') && <SmsRail />}
    </div>
  )
}