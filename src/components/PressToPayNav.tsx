import {
  Building2,
  CreditCard,
  Gauge,
  Network,
  Percent,
  ReceiptText,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import './PressToPayNav.css'

interface WorkspaceLink {
  to: string
  icon: LucideIcon
  ar: string
  en: string
  keys: string[]
  aliases?: string[]
  roles?: string[]
}

const ADMIN_ROLES = ['owner', 'admin', 'super_admin']

const WORKSPACE_LINKS: WorkspaceLink[] = [
  { to: '/press-to-pay', aliases: ['/api-dashboard'], icon: Gauge, ar: 'نظرة عامة', en: 'Overview', keys: ['dashboard'] },
  { to: '/transactions', icon: ReceiptText, ar: 'المعاملات', en: 'Transactions', keys: ['transactions', 'all_transactions'] },
  { to: '/performance', icon: Network, ar: 'المزوّدون', en: 'Providers', keys: ['reports', 'analytics', 'dashboard', 'transactions', 'merchants'] },
  { to: '/merchants', icon: Building2, ar: 'التجار', en: 'Merchants', keys: ['merchants'] },
  { to: '/payment-methods', icon: CreditCard, ar: 'طرق الدفع', en: 'Payment methods', keys: ['wallets', 'payment_methods'] },
  { to: '/revenue', icon: Percent, ar: 'العمولات', en: 'Commissions', keys: ['revenue_center'] },
  { to: '/admin/fees', aliases: ['/admin'], icon: Settings, ar: 'الإعدادات', en: 'Settings', keys: ['fees', 'settings'], roles: ADMIN_ROLES },
]

export default function PressToPayNav() {
  const { pathname } = useLocation()
  const { can, user } = useAuth()
  const { t, locale } = useLocale()
  const visibleLinks = WORKSPACE_LINKS.filter((item) => item.keys.some((key) => can(key)) && (!item.roles || (user && item.roles.includes(user.role))))

  return (
    <section className="presstopay-workspace" aria-label={t('مساحة PressToPay', 'PressToPay workspace')}>
      <div className="presstopay-workspace-brand">
        <span className="presstopay-mark" aria-hidden="true">P</span>
        <div>
          <strong>PressToPay</strong>
          <small>{t('تشغيل المدفوعات داخل OnTarget', 'Payment operations inside OnTarget')}</small>
        </div>
      </div>
      <nav className="presstopay-tabs" aria-label={t('وحدات PressToPay', 'PressToPay modules')}>
        {visibleLinks.map((item) => {
          const active = pathname === item.to || item.aliases?.includes(pathname) === true
          const Icon = item.icon
          return (
            <Link key={item.to} to={item.to} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
              <Icon size={16} strokeWidth={2.1} aria-hidden="true" />
              <span>{locale === 'ar' ? item.ar : item.en}</span>
            </Link>
          )
        })}
      </nav>
    </section>
  )
}
