import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import BinanceSubNav from '../components/BinanceSubNav'
import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

interface Config { p2p_enabled: boolean; p2p_asset: string; p2p_fiat: string; max_p2p_order_amount: number | null; max_p2p_24h_amount: number | null; has_credentials: boolean; updated_at: string | null }
interface Data { config: Config | null; execution_capability: 'unavailable'; execution_reason: string }
interface Health { connected: boolean; reason: string | null; provider_status?: number; checked_at: string }
interface MarketPrice { symbol: string; price: string }
interface C2cOrder { orderNumber?: string; advNo?: string; tradeType?: string; asset?: string; fiat?: string; fiatSymbol?: string; amount?: string; totalPrice?: string; unitPrice?: string; orderStatus?: string; createTime?: number; commission?: string }
interface ExecutionLog { id: string; actor_name: string; side: 'BUY' | 'SELL'; asset: string; fiat: string; fiat_amount: number; advertisement_number: string | null; confirmed_at: string; status: string; provider_order_number: string | null; provider_http_status: number | null; failure_code: string | null }

export default function Binance() {
  const { t } = useLocale(); const { user } = useAuth(); const isSuperAdmin = user?.role === 'super_admin'; const isMobile = useIsMobile()
  const [data, setData] = useState<Data | null>(null); const [err, setErr] = useState(''); const [msg, setMsg] = useState('')
  const [limits, setLimits] = useState({ perOrder: '', daily: '' }); const [keys, setKeys] = useState({ api_key: '', api_secret: '' })
  const [prices, setPrices] = useState<MarketPrice[]>([]); const [orders, setOrders] = useState<C2cOrder[]>([]); const [side, setSide] = useState<'BUY' | 'SELL'>('BUY'); const [busy, setBusy] = useState(false)
  const [executions, setExecutions] = useState<ExecutionLog[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [tab, setTab] = useState<'overview' | 'settings'>('overview')
  const load = useCallback(async () => { try { const d = await api<Data>('/api/binance'); setData(d); setLimits({ perOrder: d.config?.max_p2p_order_amount ? String(d.config.max_p2p_order_amount) : '', daily: d.config?.max_p2p_24h_amount ? String(d.config.max_p2p_24h_amount) : '' }); setErr('') } catch (e) { setErr(e instanceof ApiError && e.code === 'migration_required' ? t('يلزم تطبيق ترحيل قاعدة بيانات Binance أولاً.', 'The Binance database migration must be applied first.') : t('تعذر تحميل إعداد Binance.', 'Unable to load Binance configuration.')) } }, [t])
  useEffect(() => { void load() }, [load])
  useEffect(() => { api<{ prices: MarketPrice[] }>('/api/binance/market').then((result) => setPrices(result.prices)).catch(() => setPrices([])) }, [])
  useEffect(() => { if (isSuperAdmin) api<{ rows: ExecutionLog[] }>('/api/binance/executions?limit=50').then((result) => setExecutions(result.rows)).catch(() => setExecutions([])) }, [isSuperAdmin])
  const checkHealth = useCallback(() => { api<Health>('/api/binance/health').then(setHealth).catch(() => setHealth({ connected: false, reason: 'unreachable', checked_at: new Date().toISOString() })) }, [])
  useEffect(() => { checkHealth(); const timer = window.setInterval(checkHealth, 60_000); return () => window.clearInterval(timer) }, [checkHealth])
  const loadHistory = useCallback(async (nextSide: 'BUY' | 'SELL' = side) => { setBusy(true); setErr(''); try { const result = await api<{ data?: C2cOrder[] }>(`/api/binance/history?side=${nextSide}&rows=50`); setOrders(result.data ?? []) } catch (e) { setOrders([]); setErr(e instanceof ApiError && e.code === 'credentials_required' ? t('أدخل مفتاح Binance أولاً.', 'Add Binance credentials first.') : t('تعذر قراءة سجل C2C من Binance.', 'Unable to read Binance C2C history.')) } finally { setBusy(false) } }, [side, t])
  const testConnection = async () => { setBusy(true); setErr(''); setMsg(''); try { await api('/api/binance/connection'); setMsg(t('تم التحقق من المفتاح واتصال C2C بنجاح.', 'API key and C2C connection verified successfully.')) } catch (e) { setErr(e instanceof ApiError ? `${t('فشل اختبار Binance:', 'Binance test failed:')} ${e.code}` : t('فشل اختبار Binance.', 'Binance test failed.')) } finally { setBusy(false) } }
  const saveLimits = async (enabled?: boolean) => { setErr(''); setMsg(''); try { if (!limits.perOrder || !limits.daily) throw new Error('limits'); await api('/api/binance/config', { method: 'PUT', body: JSON.stringify({ max_p2p_order_amount: Number(limits.perOrder), max_p2p_24h_amount: Number(limits.daily), ...(enabled === undefined ? {} : { p2p_enabled: enabled }) }) }); setMsg(t('تم حفظ الحدود.', 'Limits saved.')); await load() } catch (e) { setErr(e instanceof ApiError && e.code === 'super_admin_required' ? t('هذه العملية متاحة لـ super_admin فقط.', 'Only super_admin can perform this action.') : t('أدخل حدَّين موجبين، ولا يمكن التفعيل قبل حفظ المفتاح.', 'Enter two positive limits; credentials are required before enabling.')) } }
  const saveKeys = async () => { setErr(''); setMsg(''); try { await api('/api/binance/credentials', { method: 'PUT', body: JSON.stringify(keys) }); setKeys({ api_key: '', api_secret: '' }); setMsg(t('حُفظ المفتاح داخل Supabase Vault وأُبقي التكامل موقوفاً.', 'Credentials saved in Supabase Vault; the integration remains disabled.')); await load() } catch { setErr(t('تعذر حفظ المفتاح بأمان.', 'Unable to store credentials securely.')) } }
  const cfg = data?.config
  return <PanelShell>
    <BinanceSubNav />
    <section className="page-head"><h2>Binance P2P — {t('تنفيذ يدوي', 'Manual execution')}</h2><p className="page-sub">{t('لا triggers ولا cron ولا تنفيذ تلقائي. كل عملية مستقبلية تتطلب تأكيداً بشرياً مسجلاً.', 'No triggers, cron, or automatic execution. Every future order requires a recorded human confirmation.')}</p></section>

    {isSuperAdmin && (
      <div className="automation-tabs" role="tablist" aria-label={t('أقسام Binance P2P', 'Binance P2P sections')}>
        <button type="button" role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>{t('نظرة عامة', 'Overview')}</button>
        <button type="button" role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>{t('الإعدادات', 'Settings')}</button>
      </div>
    )}

    {err && <div className="card warn">{err}</div>}{msg && <div className="card">{msg}</div>}

    {tab === 'overview' && <>
    <div className="card warn"><strong>{t('قيد أمان فعّال:', 'Active safety lock:')}</strong> {t('Binance لا توثّق حالياً API عامة لإنشاء أوامر P2P أو قراءة عروض السوق. لذلك التنفيذ والعروض مقفولان، ولن يستخدم النظام واجهات الموقع غير الموثقة.', 'Binance currently documents no public API for placing P2P orders or reading marketplace ads. Execution and offers are therefore locked; undocumented website endpoints are not used.')}</div>
    <div className={`binance-egp-safety ${health?.connected ? '' : 'warn'}`}><ShieldCheck size={20}/><div><strong>{health?.connected ? t('الاتصال بالحساب مؤكد', 'Account connection verified') : t('الاتصال غير مؤكد', 'Account connection not verified')}</strong><p>{health?.connected ? `${t('آخر فحص:', 'Last checked:')} ${new Date(health.checked_at).toLocaleTimeString('en-US', { timeZone: 'Africa/Cairo' })}` : t('احفظ المفتاح ثم استخدم اختبار API للتأكد من صلاحية C2C.', 'Save credentials, then use Test API to verify C2C access.')}</p></div><button className="btn-ghost btn-sm" onClick={checkHealth}>{t('فحص الآن', 'Check now')}</button></div>
    {data && <section className="card recent-card"><div className="recent-head"><h3>{t('الحالة والحدود', 'Status and limits')}</h3><span className={`pay-status-badge ${cfg?.p2p_enabled ? 'st-paid' : 'st-dim'}`}>{cfg?.p2p_enabled ? t('مفعّل', 'Enabled') : t('موقوف', 'Disabled')}</span></div>
      <div className="binance-grid"><label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('الحد الأقصى للعملية (EGP)', 'Maximum per order (EGP)')}<input className="login-input" type="number" min="0.01" step="0.01" value={limits.perOrder} disabled={!isSuperAdmin} onChange={e => setLimits({ ...limits, perOrder: e.target.value })} /></label><label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('الحد المتحرك خلال 24 ساعة (EGP)', 'Rolling 24-hour maximum (EGP)')}<input className="login-input" type="number" min="0.01" step="0.01" value={limits.daily} disabled={!isSuperAdmin} onChange={e => setLimits({ ...limits, daily: e.target.value })} /></label></div>
      {isSuperAdmin && <div className="control-row" style={{ marginTop: 12 }}><button className="btn-primary btn-sm" onClick={() => void saveLimits()}>{t('حفظ الحدود', 'Save limits')}</button><button className="btn-ghost btn-sm" disabled={!cfg?.has_credentials || busy} onClick={() => void testConnection()}>{t('اختبار API', 'Test API')}</button>{cfg?.p2p_enabled ? <button className="btn-ghost btn-sm" onClick={() => void saveLimits(false)}>{t('إيقاف', 'Disable')}</button> : <button className="btn-ghost btn-sm" onClick={() => void saveLimits(true)}>{t('تفعيل يدوي', 'Enable manual mode')}</button>}</div>}
    </section>}
    <section className="card recent-card"><div className="recent-head"><h3>{t('أسعار Binance Spot', 'Binance Spot prices')}</h3><span className="cell-sub">Public API</span></div><div className="kpi-grid">{prices.map((price) => <div className="kpi-card" key={price.symbol}><div className="kpi-value mono">{Number(price.price).toLocaleString('en-US', { maximumFractionDigits: 8 })}</div><div className="kpi-label">{price.symbol}</div></div>)}</div></section>
    <section className="card recent-card"><div className="recent-head"><h3>{t('سجل C2C الرسمي', 'Official C2C history')}</h3><div className="control-row"><button className={side === 'BUY' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => { setSide('BUY'); void loadHistory('BUY') }}>BUY</button><button className={side === 'SELL' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => { setSide('SELL'); void loadHistory('SELL') }}>SELL</button><button className="btn-ghost btn-sm" disabled={busy || !cfg?.has_credentials} onClick={() => void loadHistory()}>{busy ? t('جارٍ التحميل…', 'Loading…') : t('تحميل السجل', 'Load history')}</button></div></div>
      {isMobile ? (
        <div className="risk-card-list">
          {orders.map((order, index) => (
            <div key={order.orderNumber ?? `${order.advNo}-${index}`} className="risk-row-card">
              <div className="risk-row-card-head"><span className="mono">{order.orderNumber ?? order.advNo ?? '—'}</span><span className="pay-status-badge st-dim">{order.orderStatus ?? '—'}</span></div>
              <div className="cell-sub">{order.tradeType ?? side} · {order.amount ?? '—'} {order.asset ?? ''} @ {order.unitPrice ?? '—'} {order.fiat ?? order.fiatSymbol ?? ''}</div>
              <div className="risk-row-card-foot"><span className="mono">{t('الإجمالي', 'Total')}: {order.totalPrice ?? '—'} {order.fiat ?? order.fiatSymbol ?? ''}</span><span className="mono muted">{order.createTime ? new Date(order.createTime).toLocaleString() : '—'}</span></div>
            </div>
          ))}
          {orders.length === 0 && <p className="maven-empty">{t('اضغط تحميل السجل بعد حفظ المفتاح.', 'Load history after saving credentials.')}</p>}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الطلب', 'Order')}</th><th>{t('النوع', 'Side')}</th><th>{t('الكمية', 'Amount')}</th><th>{t('السعر', 'Unit price')}</th><th>{t('الإجمالي', 'Total')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الوقت', 'Time')}</th></tr></thead><tbody>{orders.map((order, index) => <tr key={order.orderNumber ?? `${order.advNo}-${index}`}><td className="mono">{order.orderNumber ?? order.advNo ?? '—'}</td><td>{order.tradeType ?? side}</td><td className="mono">{order.amount ?? '—'} {order.asset ?? ''}</td><td className="mono">{order.unitPrice ?? '—'} {order.fiat ?? order.fiatSymbol ?? ''}</td><td className="mono">{order.totalPrice ?? '—'} {order.fiat ?? order.fiatSymbol ?? ''}</td><td><span className="pay-status-badge st-dim">{order.orderStatus ?? '—'}</span></td><td className="mono">{order.createTime ? new Date(order.createTime).toLocaleString() : '—'}</td></tr>)}{orders.length === 0 && <tr><td colSpan={7} className="cell-sub">{t('اضغط تحميل السجل بعد حفظ المفتاح.', 'Load history after saving credentials.')}</td></tr>}</tbody></table></div>
      )}
    </section>
    <section className="card recent-card"><h3>{t('تنفيذ P2P', 'P2P execution')}</h3><p className="sidebar-hint">{t('لا توفر Binance API رسمية لإنشاء أوامر P2P أو قراءة إعلانات السوق. التنفيذ يبقى مقفولاً حتى توفير endpoint رسمي مخوّل للحساب.', 'Binance exposes no official API for P2P order placement or marketplace ads. Execution remains locked until an official account-authorized endpoint exists.')}</p></section>
    </>}

    {tab === 'settings' && isSuperAdmin && <>
    <div className="card"><strong>{t('قبل إدخال المفتاح:', 'Before entering credentials:')}</strong> {t('أنشئ مفتاحاً بصلاحية P2P فقط، وعطّل Withdrawal تماماً من إعدادات Binance.', 'Create a P2P-only key and disable Withdrawal completely in Binance settings.')}</div>
    <section className="card recent-card"><h3>{t('مفتاح API — إدخال مرة واحدة', 'API credentials — one-time entry')}</h3><p className="page-sub">{cfg?.has_credentials ? t('يوجد مفتاح محفوظ. لن يُعرض مطلقاً؛ الحفظ هنا يستبدله ويوقف التكامل.', 'Credentials exist. They are never displayed; saving here replaces them and disables the integration.') : t('لا يوجد مفتاح محفوظ.', 'No credentials stored.')}</p><div className="binance-grid"><input className="login-input" type="password" autoComplete="off" placeholder="API Key" value={keys.api_key} onChange={e => setKeys({ ...keys, api_key: e.target.value })} /><input className="login-input" type="password" autoComplete="new-password" placeholder="API Secret" value={keys.api_secret} onChange={e => setKeys({ ...keys, api_secret: e.target.value })} /></div><button className="btn-primary btn-sm" style={{ marginTop: 12 }} disabled={!keys.api_key || !keys.api_secret} onClick={() => void saveKeys()}>{t('حفظ آمن في Vault', 'Store securely in Vault')}</button></section>
    <section className="card recent-card"><div className="recent-head"><h3>{t('سجل التأكيد والتنفيذ', 'Confirmation and execution audit')}</h3><span className="cell-sub">{executions.length} {t('سجل', 'records')}</span></div>
      {isMobile ? (
        <div className="risk-card-list">
          {executions.map((row) => (
            <div key={row.id} className="risk-row-card">
              <div className="risk-row-card-head"><span>{row.actor_name}</span><span className="pay-status-badge st-dim">{row.side}</span></div>
              <div className="cell-sub">{Number(row.fiat_amount).toLocaleString('en-US')} {row.fiat} · {t('الإعلان', 'Ad')} {row.advertisement_number ?? '—'}</div>
              <div className="risk-row-card-foot">
                <span><span className={`pay-status-badge ${row.status === 'SUCCEEDED' ? 'st-paid' : row.status === 'FAILED' || row.status === 'REJECTED' ? 'st-declined' : 'st-pending'}`}>{row.status}</span>{row.failure_code && <span className="mono"> · {row.failure_code}</span>}</span>
                <span className="mono muted">{new Date(row.confirmed_at).toLocaleString()}</span>
              </div>
              {row.provider_order_number && <div className="cell-sub mono">{row.provider_order_number}{row.provider_http_status != null && ` · HTTP ${row.provider_http_status}`}</div>}
            </div>
          ))}
          {executions.length === 0 && <p className="maven-empty">{t('لا توجد تأكيدات بشرية مسجلة حتى الآن.', 'No human confirmations have been recorded yet.')}</p>}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('المؤكد', 'Confirmed by')}</th><th>{t('النوع', 'Side')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الإعلان', 'Advertisement')}</th><th>{t('النتيجة', 'Result')}</th><th>{t('طلب Binance', 'Binance order')}</th><th>{t('الوقت', 'Time')}</th></tr></thead><tbody>{executions.map((row) => <tr key={row.id}><td>{row.actor_name}</td><td><span className="pay-status-badge st-dim">{row.side}</span></td><td className="mono">{Number(row.fiat_amount).toLocaleString('en-US')} {row.fiat}</td><td className="mono">{row.advertisement_number ?? '—'}</td><td><span className={`pay-status-badge ${row.status === 'SUCCEEDED' ? 'st-paid' : row.status === 'FAILED' || row.status === 'REJECTED' ? 'st-declined' : 'st-pending'}`}>{row.status}</span>{row.failure_code && <div className="cell-sub mono">{row.failure_code}</div>}</td><td className="mono">{row.provider_order_number ?? '—'}{row.provider_http_status != null && <div className="cell-sub">HTTP {row.provider_http_status}</div>}</td><td className="mono">{new Date(row.confirmed_at).toLocaleString()}</td></tr>)}{executions.length === 0 && <tr><td colSpan={7} className="cell-sub">{t('لا توجد تأكيدات بشرية مسجلة حتى الآن.', 'No human confirmations have been recorded yet.')}</td></tr>}</tbody></table></div>
      )}
    </section>
    </>}
  </PanelShell>
}
