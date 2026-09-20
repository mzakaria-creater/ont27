import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import BinanceSubNav from '../components/BinanceSubNav'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

interface Balance { asset: string; free: string; locked: string }
interface WalletData { balances: Balance[]; accountType: string | null; canTrade: boolean | null; source: 'spot' | 'funding' | 'spot+funding'; at: string }
interface Health { connected: boolean; reason: string | null; checked_at: string }

export default function BinanceWallet() {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [data, setData] = useState<WalletData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [health, setHealth] = useState<Health | null>(null)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await api<WalletData>('/api/binance/wallet')) }
    catch (e) { setData(null); setError(e instanceof ApiError && e.code === 'credentials_required' ? t('أضف مفتاح Binance أولاً.', 'Add Binance credentials first.') : e instanceof ApiError ? `${t('تعذر قراءة رصيد Binance:', 'Unable to load Binance wallet:')} ${e.body?.message ? String(e.body.message) : e.code}` : t('تعذر قراءة رصيد Binance.', 'Unable to load Binance wallet.')) }
    finally { setLoading(false) }
  }, [t])
  useEffect(() => { void load() }, [load])
  useEffect(() => { api<Health>('/api/binance/health').then(setHealth).catch(() => setHealth({ connected: false, reason: 'unreachable', checked_at: new Date().toISOString() })) }, [])
  const totalAssets = data?.balances.length ?? 0
  const nonZero = useMemo(() => data?.balances.filter((row) => Number(row.free) > 0 || Number(row.locked) > 0) ?? [], [data])
  return <PanelShell>
    <BinanceSubNav />
    <section className="page-head binance-egp-head"><div><span className="guide-eyebrow">BINANCE · WALLET CONTROL</span><h2>{t('محفظة Binance', 'Binance Wallet')}</h2><p className="page-sub">{t('رصيد الحساب الحي مع دمج Spot وFunding.', 'Live account balances merged from Spot and Funding.')}</p></div><div className="control-row"><span className={`pay-status-badge ${health?.connected ? 'st-paid' : 'st-pending'}`}>{health?.connected ? '● Connected' : '○ Not verified'}</span><button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? 'spin' : ''}/> {t('تحديث', 'Refresh')}</button></div></section>
    <div className="binance-egp-safety"><ShieldCheck size={20}/><div><strong>{t('قراءة آمنة فقط', 'Read-only safe access')}</strong><p>{t('المفاتيح محفوظة في Vault ولا تظهر في المتصفح. لا يوجد سحب أو تحويل من هذه الصفحة.', 'Credentials stay in Vault and never reach the browser. This page cannot withdraw or transfer funds.')}</p></div></div>
    {error && <div className="card warn">{error}</div>}
    <section className="stat-grid"><article className="stat-card"><span className="stat-label">{t('الأصول', 'Assets')}</span><strong className="stat-value">{totalAssets}</strong></article><article className="stat-card"><span className="stat-label">{t('مصدر الرصيد', 'Balance source')}</span><strong className="stat-value">{data?.source === 'funding' ? 'Funding' : data?.source === 'spot' ? 'Spot' : '—'}</strong></article><article className="stat-card"><span className="stat-label">{t('نوع الحساب', 'Account type')}</span><strong className="stat-value">{data?.accountType ?? '—'}</strong></article><article className="stat-card"><span className="stat-label">{t('التداول', 'Trading')}</span><strong className="stat-value">{data?.canTrade == null ? '—' : data.canTrade ? t('مسموح','Enabled') : t('موقوف','Disabled')}</strong></article></section>
    <section className="card recent-card"><div className="recent-head"><div><h3><WalletCards size={18}/> {t('أرصدة المحافظ', 'Wallet balances')}</h3><span className="cell-sub">{data?.at ? new Date(data.at).toLocaleString('en-US', { timeZone: 'Africa/Cairo' }) : '—'}</span></div></div>
      {isMobile ? (
        <div className="risk-card-list">
          {nonZero.map((row) => (
            <div key={row.asset} className="risk-row-card">
              <div className="risk-row-card-head"><strong className="mono">{row.asset}</strong><span className="mono">{(Number(row.free) + Number(row.locked)).toLocaleString('en-US', { maximumFractionDigits: 8 })}</span></div>
              <div className="risk-row-card-foot"><span className="mono muted">{t('المتاح','Available')}: {row.free}</span><span className="mono muted">{t('مقفل','Locked')}: {row.locked}</span></div>
            </div>
          ))}
          {!nonZero.length && <p className="maven-empty">{t('لا توجد أرصدة أو لم يتم تحميل البيانات.', 'No balances available.')}</p>}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الأصل','Asset')}</th><th>{t('المتاح','Available')}</th><th>{t('مقفل','Locked')}</th><th>{t('الإجمالي','Total')}</th></tr></thead><tbody>{nonZero.map((row) => <tr key={row.asset}><td className="mono">{row.asset}</td><td className="mono">{row.free}</td><td className="mono">{row.locked}</td><td className="mono">{(Number(row.free) + Number(row.locked)).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td></tr>)}{!nonZero.length && <tr><td colSpan={4} className="cell-sub">{t('لا توجد أرصدة أو لم يتم تحميل البيانات.', 'No balances available.')}</td></tr>}</tbody></table></div>
      )}
    </section>
  </PanelShell>
}
