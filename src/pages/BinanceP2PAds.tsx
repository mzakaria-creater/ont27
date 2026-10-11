import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, Smartphone, TrendingDown, TrendingUp } from 'lucide-react'
import BinanceSubNav from '../components/BinanceSubNav'
import { api } from '../lib/api'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

interface P2pAd {
  requestedSide: 'BUY' | 'SELL'
  advNo: string | null
  tradeType: string | null
  price: number
  available: number
  minSingleTransAmount: number
  maxSingleTransAmount: number
  payTimeLimit: number
  methods: string[]
  advertiser: { nickName: string | null; monthOrderCount: number; monthFinishRate: number; userType: string | null; userGrade: string | null }
}
interface AdsData {
  asset: string
  fiat: string
  payment: string
  buyAds: P2pAd[]
  sellAds: P2pAd[]
  bestBuy: number | null
  bestSell: number | null
  midpoint: number | null
  at: string
  latencyMs: number
}

export default function BinanceP2PAds() {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [data, setData] = useState<AdsData | null>(null)
  const [payment, setPayment] = useState('VodafoneCash')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api<AdsData>(`/api/binance/p2p-ads?payment=${encodeURIComponent(payment)}&rows=10`))
    } catch {
      setData(null)
      setError(t('تعذر تحميل إعلانات Binance P2P الحية.', 'Unable to load live Binance P2P ads.'))
    }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const egp = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP`
  const amount = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const renderAds = (rows: P2pAd[], side: 'BUY' | 'SELL') => isMobile ? (
    <div className="risk-card-list">
      {rows.map((row, index) => <div key={row.advNo ?? `${side}-${index}`} className="risk-row-card">
        <div className="risk-row-card-head"><span>{row.advertiser.nickName ?? '—'}</span><span className={`pay-status-badge ${side === 'BUY' ? 'st-paid' : 'st-declined'}`}>{side}</span></div>
        <div className="cell-sub mono">{egp(row.price)} · {amount(row.available)} USDT</div>
        <div className="risk-row-card-foot"><span>{egp(row.minSingleTransAmount)} → {egp(row.maxSingleTransAmount)}</span><span>{row.payTimeLimit || '—'} min</span></div>
        <div className="cell-sub">{row.methods.join(' · ') || '—'} · {row.advertiser.monthOrderCount || 0} {t('طلب', 'orders')}</div>
      </div>)}
      {!rows.length && <p className="maven-empty">{t('لا توجد إعلانات مباشرة الآن.', 'No live ads right now.')}</p>}
    </div>
  ) : (
    <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المعلن', 'Advertiser')}</th><th>{t('السعر', 'Price')}</th><th>{t('المتاح', 'Available')}</th><th>{t('الحدود', 'Limits')}</th><th>{t('الدفع', 'Payment')}</th><th>{t('الإحصائيات', 'Stats')}</th><th>{t('المهلة', 'Window')}</th></tr></thead><tbody>
      {rows.map((row, index) => <tr key={row.advNo ?? `${side}-${index}`}><td>{row.advertiser.nickName ?? '—'}<div className="cell-sub mono">{row.advNo ?? '—'}</div></td><td className="mono">{egp(row.price)}</td><td className="mono">{amount(row.available)} USDT</td><td className="mono">{egp(row.minSingleTransAmount)} → {egp(row.maxSingleTransAmount)}</td><td>{row.methods.join(' · ') || '—'}</td><td>{row.advertiser.monthOrderCount || 0} {t('طلب', 'orders')}<div className="cell-sub">{Number(row.advertiser.monthFinishRate || 0).toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 1 })}</div></td><td>{row.payTimeLimit || '—'} min</td></tr>)}
      {!rows.length && <tr><td colSpan={7} className="cell-sub">{t('لا توجد إعلانات مباشرة الآن.', 'No live ads right now.')}</td></tr>}
    </tbody></table></div>
  )

  return <>
    <BinanceSubNav />
    <section className="page-head binance-egp-head"><div><span className="guide-eyebrow">READ ONLY · LIVE MARKETPLACE</span><h2>📣 {t('إعلانات Binance P2P', 'Binance P2P Live Ads')}</h2><p className="page-sub">USDT · EGP · {payment}</p></div><div className="control-row"><label className="filter-field">{t('طريقة الدفع','Payment')}<select className="login-input" value={payment} onChange={(event) => setPayment(event.target.value)}><option value="VodafoneCash">Vodafone Cash</option><option value="InstaPay">InstaPay</option><option value="EtisalatCash">Etisalat Cash</option><option value="all">{t('كل الطرق','All methods')}</option></select></label><button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''}/> {t('تحديث', 'Refresh')}</button></div></section>
    <div className="binance-egp-safety"><ShieldCheck size={20}/><div><strong>{t('عرض مباشر فقط — لا تنفيذ', 'Live view only — no execution')}</strong><p>{t('تُعرض الأسعار والحدود من سوق Binance P2P الحي. لا يتم إرسال أوامر أو كشف مفاتيح API.', 'Prices and limits come from the live Binance P2P marketplace. No orders are placed and no API keys are exposed.')}</p></div><a className="btn-ghost btn-sm" href="https://p2p.binance.com/en/trade/all-payments/USDT?fiat=EGP" target="_blank" rel="noreferrer">{t('فتح Binance', 'Open Binance')} <ExternalLink size={15}/></a></div>
    {error && <div className="card warn">{error}</div>}
    <section className="stat-grid"><article className="stat-card"><span className="stat-label">{t('أفضل شراء', 'Best buy')}</span><strong className="stat-value mono"><TrendingUp size={18}/> {egp(data?.bestBuy)}</strong><span className="stat-sub">{data?.buyAds.length ?? 0} ads</span></article><article className="stat-card"><span className="stat-label">{t('أفضل بيع', 'Best sell')}</span><strong className="stat-value mono"><TrendingDown size={18}/> {egp(data?.bestSell)}</strong><span className="stat-sub">{data?.sellAds.length ?? 0} ads</span></article><article className="stat-card"><span className="stat-label">{t('منتصف السوق', 'Midpoint')}</span><strong className="stat-value mono">{egp(data?.midpoint)}</strong><span className="stat-sub">{data?.at ? new Date(data.at).toLocaleTimeString('en-US', { timeZone: 'Africa/Cairo' }) : '—'}</span></article><article className="stat-card"><span className="stat-label">{t('زمن القراءة', 'Latency')}</span><strong className="stat-value mono">{data?.latencyMs ?? '—'} ms</strong><span className="stat-sub">Binance P2P</span></article></section>
    <section className="card recent-card"><div className="recent-head"><div><h3><Smartphone size={18}/> {t('إعلانات شراء USDT', 'Buy USDT ads')}</h3><span className="cell-sub">{t('من منظور المشغّل: الأسعار المتاحة لشراء USDT بالجنيه.', 'Operator view: offers available to buy USDT with EGP.')}</span></div></div>{renderAds(data?.buyAds ?? [], 'BUY')}</section>
    <section className="card recent-card"><div className="recent-head"><div><h3><Smartphone size={18}/> {t('إعلانات بيع USDT', 'Sell USDT ads')}</h3><span className="cell-sub">{t('منظور المشغّل: الأسعار المتاحة لبيع USDT مقابل الجنيه.', 'Operator view: offers available to sell USDT for EGP.')}</span></div></div>{renderAds(data?.sellAds ?? [], 'SELL')}</section>
  </>
}
