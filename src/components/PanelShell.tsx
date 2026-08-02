import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { CATEGORIES, categoryFor } from '../nav/pageCatalog'
import { api } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import type { PagePermission } from '../lib/api'

// Shared authed layout ("Live Transaction Monitor" skin): nav rail (real pages
// first, then the role's remaining permitted modules as "قريباً" placeholders),
// main content, and an always-on live SMS rail for roles with sms_live access.

const BUILT_LINKS: { to: string; icon: string; label: string; pageKey?: string }[] = [
  { to: '/', icon: '🏠', label: 'لوحة التحكم' },
  { to: '/deposits', icon: '💰', label: 'الإيداعات', pageKey: 'deposits' },
  { to: '/payouts', icon: '📤', label: 'السحوبات', pageKey: 'payouts' },
  { to: '/merchants', icon: '🏬', label: 'التجار', pageKey: 'merchants' },
  { to: '/wallets', icon: '👛', label: 'المحافظ', pageKey: 'wallets' },
  { to: '/sms', icon: '📨', label: 'SMS مباشر', pageKey: 'sms_live' },
  { to: '/merchant-link-generator', icon: '🔗', label: 'روابط الدفع', pageKey: 'checkout-builder' },
]

// page_keys already represented by a real sidebar link — kept out of the
// "قريباً" module list. pending_payouts/wallet_pool are covered by the real
// Payouts (PENDING filter) and Wallets pages.
const BUILT_PAGE_KEYS = new Set([
  'dashboard',
  'deposits',
  'payouts',
  'pending_payouts',
  'merchants',
  'wallets',
  'wallet_pool',
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
  const { pathname } = useLocation()
  const modules = usePermittedModules()
  const permsLoaded = permissions.length > 0

  return (
    <div className="dash-body">
      <nav className="sidebar">
        <div className="nav-group-label">القائمة الرئيسية</div>
        {BUILT_LINKS.filter((l) => !l.pageKey || can(l.pageKey)).map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className={`sidebar-item sidebar-link${pathname === l.to ? ' active' : ''}`}
          >
            <span className="sidebar-icon">{l.icon}</span>
            <span>{l.label}</span>
          </Link>
        ))}
        {!permsLoaded && <div className="sidebar-hint">جارٍ تحميل الصلاحيات…</div>}
        {modules.length > 0 && <div className="nav-group-label">قريباً</div>}
        {modules.map((m) => (
          <div key={m.id} className="sidebar-item soon" title="قريباً">
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
