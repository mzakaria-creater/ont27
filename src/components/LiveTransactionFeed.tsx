import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type FeedItem = { tx_id: number; ref: string; at: string | null; amount: number | null; currency: string; method: string | null; country: string | null; status: string; ui_status: 'completed' | 'processing' | 'failed' }
type Feed = { generatedAt: string; alerts: { callbackFailures: number; criticalCapacity: number; overdueSettlements: number }; items: FeedItem[] }

const REFRESH_MS = 5_000
const flag = (cc: string | null) => cc && /^[A-Za-z]{2}$/.test(cc) ? String.fromCodePoint(...cc.toUpperCase().split('').map(ch => 127397 + ch.charCodeAt(0))) : '🌐'
const clock = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

export default function LiveTransactionFeed() {
  const { t } = useLocale()
  const [feed, setFeed] = useState<Feed | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try { setFeed(await api<Feed>('/api/monitoring/feed')); setError(false) } catch { setError(true) }
  }, [])
  useEffect(() => {
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const a = feed?.alerts
  const chips: Array<{ n: number; ar: string; en: string; to: string }> = a ? [
    { n: a.callbackFailures, ar: 'فشل Callback', en: `callback failure${a.callbackFailures === 1 ? '' : 's'}`, to: '/webhooks' },
    { n: a.criticalCapacity, ar: 'سعة حرجة', en: 'critical capacity', to: '/wallets' },
    { n: a.overdueSettlements, ar: 'تسويات متأخرة', en: `overdue settlement${a.overdueSettlements === 1 ? '' : 's'}`, to: '/settlements' },
  ] : []

  return <section className="card recent-card live-feed-card">
    <div className="recent-head">
      <div>
        <h3 style={{ margin: 0 }}>{t('تدفق المعاملات المباشر', 'Live Transaction Feed')} <span className="cell-sub">— {t('آخر 10', '10 recent')}</span></h3>
        <span className="cell-sub">{t('تحديث تلقائي كل 5 ثوانٍ', 'Auto-refreshing every 5s')} · {t('آخر تحديث', 'Last update')}: {feed ? clock(feed.generatedAt) : '—'}</span>
      </div>
      <span className="live-dot"><span className="ld" />{error ? t('مقطوع', 'OFFLINE') : 'LIVE'}</span>
    </div>
    {chips.length > 0 && <div className="chip-row" style={{ marginBottom: 10 }}>
      {chips.map(c => <Link key={c.to} to={c.to} className={`pay-status-badge ${c.n > 0 ? 'st-declined' : 'st-paid'}`}>{c.n > 0 ? '⚠' : '✓'} {c.n} {t(c.ar, c.en)}</Link>)}
    </div>}
    <div className="recent-head" style={{ marginBottom: 4 }}><span className="cell-sub">{t('التدفق نشط', 'Stream active')}</span></div>
    <div className="table-wrap"><table className="data-table"><thead><tr>
      <th>{t('الوقت', 'Time')}</th><th>{t('رقم المعاملة', 'Transaction ID')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('الدولة', 'Country')}</th><th>{t('الحالة', 'Status')}</th>
    </tr></thead><tbody>
      {(feed?.items ?? []).map(r => <tr key={r.tx_id}>
        <td className="mono">{clock(r.at)}</td>
        <td><Link className="mono" to={`/transactions/${encodeURIComponent(r.ref)}`}>{r.ref}</Link></td>
        <td className="mono">{money(r.amount, r.currency)} <span className="pay-status-badge st-pending">{r.currency}</span></td>
        <td>{r.method ?? '—'}</td>
        <td>{flag(r.country)} {r.country ?? ''}</td>
        <td><span className={`pay-status-badge ${r.ui_status === 'completed' ? 'st-paid' : r.ui_status === 'failed' ? 'st-declined' : 'st-pending'}`} title={r.status}>{r.ui_status === 'completed' ? t('مكتملة', 'Completed') : r.ui_status === 'failed' ? t('فاشلة', 'Failed') : t('قيد المعالجة', 'Processing')}</span></td>
      </tr>)}
      {feed && feed.items.length === 0 && <tr><td colSpan={6} className="sidebar-hint">{t('لا توجد معاملات.', 'No transactions yet.')}</td></tr>}
      {!feed && !error && <tr><td colSpan={6} className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</td></tr>}
    </tbody></table></div>
    {error && <p className="sidebar-hint">{t('تعذّر التحديث — إعادة المحاولة تلقائيًا.', 'Update failed — retrying automatically.')}</p>}
  </section>
}
