import { Link, useLocation } from 'react-router-dom'
import { useLocale } from '../lib/locale'

// Shared cross-page navigation for the four Binance routes. They stay
// separate routes (different permission keys, independent data loads) but
// read as one connected suite instead of four unrelated sidebar entries.
const LINKS = [
  { to: '/binance', ar: 'التحكم', en: 'Control', icon: '🪙' },
  { to: '/binance/wallet', ar: 'المحفظة', en: 'Wallet', icon: '💼' },
  { to: '/binance/p2p-history', ar: 'سجل P2P', en: 'P2P History', icon: '🧾' },
  { to: '/binance/p2p-ads', ar: 'إعلانات مباشرة', en: 'Live Ads', icon: '📣' },
]

export default function BinanceSubNav() {
  const { t } = useLocale()
  const { pathname } = useLocation()
  return (
    <nav className="binance-subnav" aria-label={t('أقسام Binance', 'Binance sections')}>
      {LINKS.map((link) => (
        <Link key={link.to} to={link.to} className={pathname === link.to ? 'active' : ''} aria-current={pathname === link.to ? 'page' : undefined}>
          <span aria-hidden="true">{link.icon}</span> {t(link.ar, link.en)}
        </Link>
      ))}
    </nav>
  )
}
