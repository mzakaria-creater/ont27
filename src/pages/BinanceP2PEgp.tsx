import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck, Smartphone, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

interface Config { p2p_enabled: boolean; max_p2p_order_amount: number | null; max_p2p_24h_amount: number | null; has_credentials: boolean }
interface Order { orderNumber?: string; advNo?: string; tradeType?: string; asset?: string; fiat?: string; amount?: string; totalPrice?: string; unitPrice?: string; orderStatus?: string; createTime?: number; payMethodName?: string; paymentMethod?: string }

const amount = (value: unknown, currency = 'EGP') => `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`

export default function BinanceP2PEgp() {
  const { t } = useLocale()
  const [config, setConfig] = useState<Config | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (nextSide: 'BUY' | 'SELL' = side) => {
    setLoading(true); setError('')
    try {
      const [settings, history] = await Promise.all([
        api<{ config: Config | null }>('/api/binance'),
        api<{ data?: Order[] }>(`/api/binance/history?side=${nextSide}&rows=100`),
      ])
      setConfig(settings.config)
      setOrders((history.data ?? []).filter((row) => !row.fiat || row.fiat.toUpperCase() === 'EGP'))
    } catch (e) {
      setOrders([])
      setError(e instanceof ApiError && e.code === 'credentials_required'
        ? t('أضف مفتاح Binance المقيّد أولاً من صفحة الإعدادات.', 'Add the restricted Binance key from settings first.')
        : t('تعذّر تحميل سجل Binance P2P الآن.', 'Unable to load Binance P2P history right now.'))
    } finally { setLoading(false) }
  }, [side, t])

  useEffect(() => { void load() }, [])
  const total = useMemo(() => orders.reduce((sum, row) => sum + Number(row.totalPrice || 0), 0), [orders])
  const completed = useMemo(() => orders.filter((row) => /complete|success|paid/i.test(row.orderStatus ?? '')).length, [orders])

  return <PanelShell>
    <section className="page-head binance-egp-head">
      <div><span className="guide-eyebrow">BINANCE P2P · EGP</span><h2>🪙 {t('Binance P2P — فودافون كاش', 'Binance P2P — Vodafone Cash')}</h2><p className="page-sub">{t('عرض تشغيلي لطلبات EGP مع مسار دفع فودافون كاش وتنفيذ بشري فقط.', 'Operational EGP order view for Vodafone Cash with human-only execution.')}</p></div>
      <button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''}/> {t('تحديث', 'Refresh')}</button>
    </section>

    <div className="binance-egp-safety"><ShieldCheck size={20}/><div><strong>{t('وضع يدوي محمي', 'Protected manual mode')}</strong><p>{t('لا يتم إنشاء أي طلب تلقائياً. صلاحية السحب يجب أن تبقى معطلة في Binance.', 'No order is created automatically. Withdrawal permission must remain disabled in Binance.')}</p></div></div>
    {error && <div className="card warn">{error}</div>}

    <section className="stat-grid">
      <article className="stat-card"><span className="stat-label">{t('طلبات EGP', 'EGP orders')}</span><strong className="stat-value">{orders.length}</strong></article>
      <article className="stat-card"><span className="stat-label">{t('إجمالي القيمة', 'Total value')}</span><strong className="stat-value mono">{amount(total)}</strong></article>
      <article className="stat-card"><span className="stat-label">{t('مكتملة', 'Completed')}</span><strong className="stat-value">{completed}</strong></article>
      <article className="stat-card"><span className="stat-label">{t('حد العملية', 'Per-order limit')}</span><strong className="stat-value mono">{config?.max_p2p_order_amount ? amount(config.max_p2p_order_amount) : '—'}</strong></article>
      <article className="stat-card"><span className="stat-label">{t('حد 24 ساعة', '24h limit')}</span><strong className="stat-value mono">{config?.max_p2p_24h_amount ? amount(config.max_p2p_24h_amount) : '—'}</strong></article>
    </section>

    <section className="card recent-card">
      <div className="recent-head"><div className="binance-payment-heading"><span className="binance-vf-mark">V</span><div><h3>{t('طلبات فودافون كاش', 'Vodafone Cash orders')}</h3><span className="cell-sub">USDT ↔ EGP</span></div></div><div className="control-row"><button className={side === 'BUY' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => { setSide('BUY'); void load('BUY') }}>BUY</button><button className={side === 'SELL' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => { setSide('SELL'); void load('SELL') }}>SELL</button></div></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الطلب', 'Order')}</th><th>{t('النوع', 'Side')}</th><th>{t('الأصل', 'Asset')}</th><th>{t('الكمية', 'Amount')}</th><th>{t('السعر', 'Price')}</th><th>{t('الإجمالي', 'Total')}</th><th>{t('طريقة الدفع', 'Payment method')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الوقت', 'Time')}</th></tr></thead><tbody>
        {orders.map((row, index) => <tr key={row.orderNumber ?? `${row.advNo}-${index}`}><td className="mono">{row.orderNumber ?? row.advNo ?? '—'}</td><td><span className={`pay-status-badge ${row.tradeType === 'SELL' ? 'st-declined' : 'st-paid'}`}>{row.tradeType ?? side}</span></td><td className="mono">{row.asset ?? 'USDT'}</td><td className="mono">{row.amount ?? '—'}</td><td className="mono">{amount(row.unitPrice)}</td><td className="mono">{amount(row.totalPrice)}</td><td><span className="binance-vf-method"><Smartphone size={14}/> {row.payMethodName ?? row.paymentMethod ?? 'Vodafone Cash'}</span></td><td><span className="pay-status-badge st-dim">{row.orderStatus ?? '—'}</span></td><td className="mono">{row.createTime ? new Date(row.createTime).toLocaleString() : '—'}</td></tr>)}
        {!orders.length && <tr><td colSpan={9}><div className="binance-empty"><WalletCards size={28}/><strong>{t('لا توجد طلبات EGP متاحة في السجل.', 'No EGP orders are available in the history.')}</strong><span>{t('هذه الصفحة لا تستخدم إعلانات Binance غير الموثقة.', 'This page does not use undocumented Binance advertisements.')}</span></div></td></tr>}
      </tbody></table></div>
    </section>
  </PanelShell>
}
