import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Bal = { currency: string; available: number; pending: number; held: number; reserved: number; released: number }
type Data = { generatedAt: string; balances: Bal[]; flow24h: { inflowEgp: number; inflows: number; outflowEgp: number; outflows: number }; binanceAt: string | null; errors: string[] }
const FLAGS: Record<string, string> = { EGP: '🇪🇬', USDT: '🔷', USD: '🇺🇸' }

export default function Treasury() {
  const { t } = useLocale()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    setBusy(true)
    try { setData(await api<Data>('/api/treasury/balances')); setErr(false) } catch { setErr(true) } finally { setBusy(false) }
  }, [])
  useEffect(() => { void load(); const id = setInterval(() => { if (!document.hidden) void load() }, 30_000); return () => clearInterval(id) }, [load])

  const egp = data?.balances.find(b => b.currency === 'EGP')
  const rows: Array<[string, string, keyof Bal]> = [['متاح', 'Available', 'available'], ['معلّق', 'Pending', 'pending'], ['محجوز (مخاطر)', 'Held', 'held'], ['مخصّص للسحب', 'Reserved', 'reserved'], ['تم تسويته', 'Released', 'released']]
  return <>
    <section className="page-head">
      <div className="recent-head"><h2 style={{ margin: 0 }}>🏦 {t('الخزينة', 'Treasury')}</h2><button className="btn-ghost btn-sm" disabled={busy} onClick={() => void load()}><RefreshCw size={14} className={busy ? 'spin' : ''} /> {t('تحديث', 'Refresh')}</button></div>
      <p className="page-sub">{t('أرصدة العملات من بيانات النظام الفعلية.', 'Currency balances from live system data.')}</p>
    </section>
    {(err || data?.errors.length) ? <div className="card warn">{t('بعض المصادر تعذّر تحميلها.', 'Some sources failed to load.')} {data?.errors.join(' · ')}</div> : null}
    <div className="stat-grid">
      <div className="stat-card"><span className="stat-label">{t('إجمالي المتاح (EGP)', 'Total available (EGP)')}</span><span className="stat-value">{egp ? money(egp.available, 'EGP') : '…'}</span><span className="stat-sub">{t('أرصدة المحافظ النشطة', 'Active wallet balances')}</span></div>
      <div className="stat-card"><span className="stat-label">{t('معلّقة (EGP)', 'Pending clearance (EGP)')}</span><span className="stat-value">{egp ? money(egp.pending, 'EGP') : '…'}</span><span className="stat-sub">{t('إيداعات قيد الانتظار', 'Deposits awaiting confirmation')}</span></div>
      <div className="stat-card"><span className="stat-label">{t('محجوز (EGP)', 'Total held (EGP)')}</span><span className="stat-value">{egp ? money(egp.held, 'EGP') : '…'}</span><span className="stat-sub">{t('محظور من التسوية', 'Blocked from settlement')}</span></div>
      <div className="stat-card"><span className="stat-label">{t('صافي تدفق آخر 24 ساعة', 'Net flow, last 24h')}</span><span className="stat-value">{data ? money(data.flow24h.inflowEgp - data.flow24h.outflowEgp, 'EGP') : '…'}</span><span className="stat-sub">{data ? `${data.flow24h.inflows} ${t('داخل', 'inflows')} · ${data.flow24h.outflows} ${t('خارج', 'outflows')}` : ''}</span></div>
    </div>
    <section className="card recent-card"><div className="recent-head"><h3>{t('أرصدة العملات', 'Currency balances')}</h3></div>
      <div className="treasury-grid">
        {(data?.balances ?? []).map(b => {
          const total = b.available + b.pending + b.held + b.reserved
          return <article key={b.currency} className="treasury-card">
            <header><strong>{FLAGS[b.currency] ?? '💱'} {b.currency}</strong><span className="cell-sub">{t('الإجمالي', 'Total')}: {money(total, b.currency)}</span></header>
            <dl>{rows.map(([ar, en, k]) => <div key={k}><dt>{t(ar, en)}</dt><dd className="mono">{money(b[k] as number, b.currency)}</dd></div>)}</dl>
          </article>
        })}
      </div>
      {data?.binanceAt && <p className="sidebar-hint">USDT: Binance {new Date(data.binanceAt).toLocaleString()}</p>}
    </section>
  </>
}
