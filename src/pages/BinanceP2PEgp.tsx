import { useCallback, useEffect, useMemo, useState } from 'react'
import { Filter, RefreshCw, ShieldCheck, Smartphone, Users, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

interface Config { has_credentials: boolean; max_p2p_order_amount: number | null; max_p2p_24h_amount: number | null }
interface Order { orderNumber: string | null; advNo: string | null; tradeType: 'BUY' | 'SELL'; asset: string; fiat: string; amount: string | null; totalPrice: string | null; orderStatus: string | null; createTime: number | null; trader: string | null; paymentMethod: string | null }
interface Trader { trader: string; orders: number; totalEgp: number; buyEgp: number; sellEgp: number }

const egp = (value: unknown) => `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP`
const cairoDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(date)
const monthStart = () => { const date = new Date(); date.setDate(1); return cairoDate(date) }

export default function BinanceP2PEgp() {
  const { t } = useLocale()
  const [config, setConfig] = useState<Config | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [traders, setTraders] = useState<Trader[]>([])
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(cairoDate())
  const [trader, setTrader] = useState('')
  const [method, setMethod] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const fromMs = Date.parse(`${from}T00:00:00+02:00`)
      const toMs = Date.parse(`${to}T23:59:59+02:00`)
      const query = `/api/binance/p2p-report?from=${fromMs}&to=${toMs}${trader ? `&trader=${encodeURIComponent(trader)}` : ''}${method ? `&method=${encodeURIComponent(method)}` : ''}`
      const [settings, report] = await Promise.all([api<{ config: Config | null }>('/api/binance'), api<{ orders: Order[]; traders: Trader[] }>(query)])
      setConfig(settings.config); setOrders(report.orders ?? []); setTraders(report.traders ?? [])
    } catch (e) {
      setOrders([]); setTraders([]); setError(e instanceof ApiError && e.code === 'credentials_required' ? t('أضف مفتاح Binance أولاً من الإعدادات.', 'Add Binance credentials first from settings.') : t('تعذر تحميل سجل Binance P2P.', 'Unable to load Binance P2P history.'))
    } finally { setLoading(false) }
  }, [from, to, trader, method, t])
  useEffect(() => { void load() }, [])

  const total = useMemo(() => orders.reduce((sum, row) => sum + Number(row.totalPrice || 0), 0), [orders])
  const buy = useMemo(() => orders.filter((row) => row.tradeType === 'BUY').reduce((sum, row) => sum + Number(row.totalPrice || 0), 0), [orders])
  const sell = useMemo(() => orders.filter((row) => row.tradeType === 'SELL').reduce((sum, row) => sum + Number(row.totalPrice || 0), 0), [orders])
  const methods = useMemo(() => [...new Set(orders.map((row) => row.paymentMethod).filter((value): value is string => !!value))].sort(), [orders])
  const grouped = useMemo(() => traders.map((summary) => ({ summary, rows: orders.filter((row) => (row.trader ?? 'Unknown trader') === summary.trader) })), [orders, traders])

  return <PanelShell>
    <section className="page-head binance-egp-head"><div><span className="guide-eyebrow">BINANCE C2C · EGP OPERATIONS</span><h2>{t('Binance P2P — Vodafone Cash', 'Binance P2P — EGP Vodafone Cash')}</h2><p className="page-sub">{t('تقرير حي مقسم حسب Trader مع إجمالي BUY وSELL لكل طرف.', 'Live report split by trader with BUY and SELL totals per counterparty.')}</p></div><button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''}/> {t('تحديث', 'Refresh')}</button></section>
    <div className="binance-egp-safety"><ShieldCheck size={20}/><div><strong>{t('قراءة محمية من Binance', 'Protected Binance read')}</strong><p>{t('المفتاح محفوظ داخل Vault ولا يظهر في المتصفح. لا يوجد تنفيذ تلقائي.', 'The key is stored in Vault and never reaches the browser. No automatic execution is enabled.')}</p></div></div>
    {error && <div className="card warn">{error}</div>}
    <section className="binance-report-filters card"><div className="recent-head"><h3><Filter size={17}/> {t('فلاتر التقرير', 'Report filters')}</h3><span className="cell-sub">{from} → {to}</span></div><div className="binance-grid"><label className="filter-field">{t('من','From')}<input className="login-input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}/></label><label className="filter-field">{t('إلى','To')}<input className="login-input" type="date" value={to} min={from} max={cairoDate()} onChange={(e) => setTo(e.target.value)}/></label><label className="filter-field">Trader<select className="login-input" value={trader} onChange={(e) => setTrader(e.target.value)}><option value="">{t('كل التجار','All traders')}</option>{traders.map((row) => <option key={row.trader} value={row.trader}>{row.trader}</option>)}</select></label><label className="filter-field">{t('طريقة الدفع','Payment method')}<select className="login-input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="">{t('كل الطرق','All methods')}</option>{methods.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div><div className="control-row"><button className="btn-primary btn-sm" onClick={() => void load()} disabled={loading}>{loading ? t('تحميل…','Loading…') : t('تطبيق','Apply')}</button><button className="btn-ghost btn-sm" onClick={() => { setFrom(monthStart()); setTo(cairoDate()); setTrader(''); setMethod('') }}>{t('مسح','Clear')}</button></div></section>
    <section className="stat-grid"><article className="stat-card"><span className="stat-label">{t('صفقات EGP','EGP trades')}</span><strong className="stat-value">{orders.length}</strong></article><article className="stat-card"><span className="stat-label">{t('إجمالي الحجم','Total volume')}</span><strong className="stat-value mono">{egp(total)}</strong></article><article className="stat-card"><span className="stat-label">BUY</span><strong className="stat-value mono">{egp(buy)}</strong></article><article className="stat-card"><span className="stat-label">SELL</span><strong className="stat-value mono">{egp(sell)}</strong></article><article className="stat-card"><span className="stat-label">{t('التجار','Traders')}</span><strong className="stat-value">{traders.length}</strong></article></section>
    <section className="binance-trader-split"><div className="recent-head"><div><h3><Users size={18}/> {t('تقرير مقسم حسب Trader', 'Trader split report')}</h3><span className="cell-sub">{t('كل بطاقة تعرض صفقات هذا الطرف فقط.', 'Each card contains only this trader’s trades.')}</span></div><span className="binance-vf-method"><Smartphone size={14}/> Vodafone Cash · EGP</span></div>{grouped.map(({ summary, rows }) => <article className="card recent-card binance-trader-card" key={summary.trader}><header className="recent-head"><div><h3>{summary.trader}</h3><span className="cell-sub">{summary.orders} {t('صفقة','trades')} · {egp(summary.totalEgp)}</span></div><div className="binance-trader-totals"><span className="positive-text">BUY {egp(summary.buyEgp)}</span><span className="negative-text">SELL {egp(summary.sellEgp)}</span></div></header><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الطلب','Order')}</th><th>{t('النوع','Side')}</th><th>{t('الأصل','Asset')}</th><th>{t('الكمية','Qty')}</th><th>{t('الإجمالي','Total EGP')}</th><th>{t('طريقة الدفع','Method')}</th><th>{t('الحالة','Status')}</th><th>{t('الوقت','Time')}</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.orderNumber ?? `${row.advNo}-${index}`}><td className="mono">{row.orderNumber ?? row.advNo ?? '—'}</td><td><span className={`pay-status-badge ${row.tradeType === 'SELL' ? 'st-declined' : 'st-paid'}`}>{row.tradeType}</span></td><td className="mono">{row.asset}</td><td className="mono">{row.amount ?? '—'}</td><td className="mono">{egp(row.totalPrice)}</td><td>{row.paymentMethod ?? '—'}</td><td><span className="pay-status-badge st-dim">{row.orderStatus ?? '—'}</span></td><td className="mono">{row.createTime ? new Date(row.createTime).toLocaleString('en-US', { timeZone: 'Africa/Cairo' }) : '—'}</td></tr>)}</tbody></table></div></article>)}{!grouped.length && <div className="card binance-empty"><WalletCards size={28}/><strong>{t('لا توجد صفقات مطابقة للفلاتر.', 'No trades match the filters.')}</strong><span>{config?.has_credentials ? t('غيّر الفترة أو Trader المحدد.', 'Try another date range or trader.') : t('أدخل مفاتيح Binance من صفحة الإعدادات.', 'Add Binance credentials from settings.')}</span></div>}</section>
  </PanelShell>
}
