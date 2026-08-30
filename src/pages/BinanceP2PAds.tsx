import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { useLocale } from '../lib/locale'

interface Price { symbol: string; price: string }

export default function BinanceP2PAds() {
  const { t } = useLocale()
  const [prices, setPrices] = useState<Price[]>([])
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true)
    try { const result = await api<{ prices: Price[] }>('/api/binance/market?symbols=USDTUSDC,BTCUSDT'); setPrices(result.prices ?? []) }
    catch { setPrices([]) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  return <PanelShell>
    <section className="page-head binance-egp-head"><div><span className="guide-eyebrow">READ ONLY · MARKETPLACE</span><h2>📣 {t('إعلانات Binance P2P', 'Binance P2P Live Ads')}</h2><p className="page-sub">USDT · EGP · Vodafone Cash</p></div><button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={15}/> {t('تحديث السعر', 'Refresh price')}</button></section>
    <div className="binance-egp-safety"><ShieldCheck size={20}/><div><strong>{t('عرض فقط — لا تنفيذ', 'View only — no execution')}</strong><p>{t('Binance لا توفر إعلانات P2P عبر API عامة موثقة. لن نستخدم واجهة موقع خاصة أو غير مستقرة.', 'Binance does not expose P2P advertisements through a documented public API. Private or unstable website endpoints are not used.')}</p></div></div>
    <section className="stat-grid">{prices.map((row) => <article className="stat-card" key={row.symbol}><span className="stat-label">{row.symbol}</span><strong className="stat-value mono">{Number(row.price).toLocaleString('en-US', { maximumFractionDigits: 8 })}</strong><span className="stat-sub">Binance Spot</span></article>)}</section>
    <section className="card recent-card binance-ads-empty"><div className="binance-vf-mark">V</div><Smartphone size={34}/><h3>{t('سوق EGP · فودافون كاش', 'EGP · Vodafone Cash marketplace')}</h3><p>{t('افتح سوق Binance الرسمي لمشاهدة المعلنين والأسعار والحدود المتاحة لحظياً.', 'Open the official Binance marketplace to view current advertisers, prices, and limits.')}</p><a className="btn-primary" href="https://p2p.binance.com/en/trade/all-payments/USDT?fiat=EGP" target="_blank" rel="noreferrer">{t('فتح إعلانات Binance المباشرة', 'Open Binance live ads')} <ExternalLink size={16}/></a></section>
  </PanelShell>
}
