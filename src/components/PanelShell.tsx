import { useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { CATEGORIES, categoryFor } from '../nav/pageCatalog'
import type { PagePermission } from '../lib/api'

// Shared authed layout: sidebar nav (real pages first, then the role's
// remaining permitted modules as "قريباً" placeholders) + main content area.

const BUILT_LINKS: { to: string; icon: string; label: string; pageKey?: string }[] = [
  { to: '/', icon: '🏠', label: 'لوحة التحكم' },
  { to: '/deposits', icon: '💰', label: 'الإيداعات', pageKey: 'deposits' },
  { to: '/payouts', icon: '📤', label: 'السحوبات', pageKey: 'payouts' },
  { to: '/merchants', icon: '🏬', label: 'التجار', pageKey: 'merchants' },
  { to: '/wallets', icon: '👛', label: 'المحافظ', pageKey: 'wallets' },
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

export default function PanelShell({ children }: { children: ReactNode }) {
  const { permissions, can } = useAuth()
  const { pathname } = useLocation()
  const modules = usePermittedModules()
  const permsLoaded = permissions.length > 0

  return (
    <div className="dash-body">
      <nav className="sidebar">
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
        {modules.map((m) => (
          <div key={m.id} className="sidebar-item soon" title="قريباً">
            <span className="sidebar-icon">{m.icon}</span>
            <span>{m.label}</span>
            <span className="sidebar-count">{m.pages.length}</span>
          </div>
        ))}
      </nav>
      <main className="dash-main">{children}</main>
    </div>
  )
}
