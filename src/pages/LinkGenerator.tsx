import { Fragment, useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

interface LinkStats { sessions: number; paid: number; paid_amount: number }
interface LinkAnalytics {
  opens: number; visitors: number; blockedOpens: number; lastOpenAt: string | null
  sessions: number; paid: number; paidAmount: number; lastPaidAt: string | null
  // Two rates, not one. A link can convert every session it starts while
  // almost nobody who opens it gets that far, and a single percentage hides
  // which half is failing.
  openToSession: number | null; sessionToPaid: number | null
  methods: { method: string; uses: number; paid: number }[]
}
// Derived server-side from the clock and the counter, never stored: a link
// becomes expired by time passing and exhausted by its last use, so a stored
// value would be wrong between whatever job maintained it.
type LinkStatus = 'active' | 'expired' | 'exhausted' | 'disabled'
interface PaymentLink {
  id: string
  short_code: string
  title: string | null
  amount_mode: 'fixed' | 'open'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
  currency: string
  expires_at: string | null
  max_uses: number | null
  use_count: number
  active: boolean
  created_at: string
  status: LinkStatus
  stats: LinkStats
  analytics: LinkAnalytics | null
}
interface Merchant { id: string; name: string; code: string | null }

export default function LinkGenerator() {
  const { can } = useAuth()
  const { t } = useLocale()
  const [links, setLinks] = useState<PaymentLink[]>([])
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | LinkStatus | 'paid'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [form, setForm] = useState({
    title: '', merchant_id: '', amount_mode: 'open', amount: '',
    min_amount: '', max_amount: '', expires_at: '', max_uses: '',
  })

  const load = useCallback(async () => {
    try {
      const [{ links }, { merchants }] = await Promise.all([
        api<{ links: PaymentLink[] }>('/api/links'),
        api<{ merchants: Merchant[] }>('/api/links/merchants'),
      ])
      setLinks(links)
      setMerchants(merchants)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? t('دورك لا يملك صلاحية عرض روابط الدفع', 'Your role cannot view payment links') : t('تعذر تحميل الروابط', 'Failed to load links'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const expire = async (l: PaymentLink) => {
    // Irreversible by design — expiry is a moment that has passed, not a
    // switch. Disabling is the reversible one, and it already exists.
    if (!window.confirm(t(`إنهاء الرابط ${l.short_code} الآن؟ لا يمكن التراجع.`, `Expire link ${l.short_code} now? This cannot be undone.`))) return
    try { await api(`/api/links/${l.id}/expire`, { method: 'POST' }); await load() }
    catch { setError(t('تعذّر إنهاء الرابط.', 'Could not expire the link.')) }
  }

  const duplicate = async (l: PaymentLink) => {
    try { await api(`/api/links/${l.id}/duplicate`, { method: 'POST' }); await load() }
    catch { setError(t('تعذّر نسخ الرابط.', 'Could not duplicate the link.')) }
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/api/links', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title || undefined,
          merchant_id: form.merchant_id || undefined,
          amount_mode: form.amount_mode,
          amount: form.amount || undefined,
          min_amount: form.min_amount || undefined,
          max_amount: form.max_amount || undefined,
          expires_at: form.expires_at || undefined,
          max_uses: form.max_uses || undefined,
        }),
      })
      setForm({ title: '', merchant_id: '', amount_mode: 'open', amount: '', min_amount: '', max_amount: '', expires_at: '', max_uses: '' })
      await load()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? t('دورك لا يملك صلاحية إنشاء روابط', 'Your role cannot create links') : t('تعذر إنشاء الرابط', 'Failed to create link'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (link: PaymentLink) => {
    try {
      await api(`/api/links/${link.id}`, { method: 'PATCH', body: JSON.stringify({ active: !link.active }) })
      await load()
    } catch {
      setError(t('تعذر تعديل الرابط', 'Failed to update link'))
    }
  }

  const copyUrl = async (link: PaymentLink) => {
    await navigator.clipboard.writeText(`${location.origin}/payment-checkout?code=${link.short_code}`).catch(() => {})
    setCopied(link.id)
    setTimeout(() => setCopied(null), 1500)
  }

  const totals = links.reduce(
    (t, l) => ({ links: t.links + 1, sessions: t.sessions + l.stats.sessions, paid: t.paid + l.stats.paid, amount: t.amount + l.stats.paid_amount }),
    { links: 0, sessions: 0, paid: 0, amount: 0 },
  )

  return (
    <main className="page">
      <h2>{t('مولد روابط الدفع', 'Payment link generator')}</h2>
      <div className="kpis">
        <div className="kpi"><b>{totals.links}</b><span>{t('رابط', 'links')}</span></div>
        <div className="kpi"><b>{totals.sessions}</b><span>{t('جلسة', 'sessions')}</span></div>
        <div className="kpi"><b>{totals.paid}</b><span>{t('مدفوعة', 'paid')}</span></div>
        <div className="kpi"><b className="mono">{totals.amount.toLocaleString()}</b><span>{t('إجمالي مدفوع', 'total paid')}</span></div>
      </div>

      {can('checkout-builder', 'can_create') && (
        <form className="card link-form" onSubmit={create}>
          <div className="grid-3">
            <label className="field"><span>{t('العنوان', 'Title')}</span>
              <input value={form.title} onChange={set('title')} placeholder={t('مثال: إيداع عميل VIP', 'e.g. VIP client deposit')} /></label>
            <label className="field"><span>{t('التاجر', 'Merchant')}</span>
              <select value={form.merchant_id} onChange={set('merchant_id')}>
                <option value="">{t('— بدون تاجر —', '— no merchant —')}</option>
                {merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select></label>
            <label className="field"><span>{t('نوع المبلغ', 'Amount type')}</span>
              <select value={form.amount_mode} onChange={set('amount_mode')}>
                <option value="open">{t('مفتوح', 'Open')}</option>
                <option value="fixed">{t('ثابت', 'Fixed')}</option>
              </select></label>
            {form.amount_mode === 'fixed' ? (
              <label className="field"><span>{t('المبلغ (EGP)', 'Amount (EGP)')}</span>
                <input dir="ltr" inputMode="decimal" value={form.amount} onChange={set('amount')} required /></label>
            ) : (
              <>
                <label className="field"><span>{t('حد أدنى', 'Min')}</span>
                  <input dir="ltr" inputMode="decimal" value={form.min_amount} onChange={set('min_amount')} /></label>
                <label className="field"><span>{t('حد أقصى', 'Max')}</span>
                  <input dir="ltr" inputMode="decimal" value={form.max_amount} onChange={set('max_amount')} /></label>
              </>
            )}
            <label className="field"><span>{t('تاريخ الانتهاء', 'Expiry')}</span>
              <input type="datetime-local" dir="ltr" value={form.expires_at} onChange={set('expires_at')} /></label>
            <label className="field"><span>{t('حد الاستخدامات', 'Usage limit')}</span>
              <input dir="ltr" inputMode="numeric" value={form.max_uses} onChange={set('max_uses')} /></label>
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="btn-primary" disabled={busy}>{busy ? t('جارٍ الإنشاء…', 'Creating…') : t('إنشاء رابط', 'Create link')}</button>
        </form>
      )}

      <div className="filter-bar">
        {([
          ['all', t('الكل', 'All')],
          ['active', t('نشط', 'Active')],
          ['expired', t('منتهٍ', 'Expired')],
          ['exhausted', t('مستنفَد', 'Exhausted')],
          ['disabled', t('موقوف', 'Disabled')],
          ['paid', t('حصّل مدفوعات', 'Has payments')],
        ] as [typeof filter, string][]).map(([id, label]) => (
          <button key={id} className={filter === id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setFilter(id)}>
            {label}
            <span className="chip-count">
              {id === 'all' ? links.length
                : id === 'paid' ? links.filter((l) => l.stats.paid > 0).length
                : links.filter((l) => l.status === id).length}
            </span>
          </button>
        ))}
      </div>

      <div className="card table-card">
        <table className="links-table">
          <thead>
            <tr>
              <th>{t('الكود', 'Code')}</th><th>{t('العنوان', 'Title')}</th><th>{t('المبلغ', 'Amount')}</th>
              <th>{t('الاستخدام', 'Usage')}</th><th>{t('فتحات', 'Opens')}</th>
              <th>{t('جلسات', 'Sessions')}</th><th>{t('مدفوع', 'Paid')}</th>
              <th>{t('الحالة', 'Status')}</th><th />
            </tr>
          </thead>
          <tbody>
            {links
              .filter((l) => filter === 'all' || (filter === 'paid' ? l.stats.paid > 0 : l.status === filter))
              .map((l) => (
              // The key belongs on the fragment: the row and its expanded
              // detail are two siblings of one logical entry, and keying the
              // children instead makes React treat them as unrelated.
              <Fragment key={l.id}>
              <tr className={l.status === 'active' ? '' : 'row-dim'}>
                <td className="mono">{l.short_code}</td>
                <td>{l.title ?? '—'}</td>
                <td className="mono" dir="ltr">
                  {l.amount_mode === 'fixed' ? `${l.amount} ${l.currency}` : `${l.min_amount ?? '∗'} – ${l.max_amount ?? '∗'} ${l.currency}`}
                </td>
                <td className="mono" dir="ltr">{l.use_count}{l.max_uses ? ` / ${l.max_uses}` : ''}</td>
                <td className="mono">
                  {l.analytics?.opens ?? 0}
                  {(l.analytics?.visitors ?? 0) > 0 && (
                    <div className="cell-sub">{l.analytics?.visitors} {t('زائر', 'visitors')}</div>
                  )}
                  {(l.analytics?.blockedOpens ?? 0) > 0 && (
                    <div className="cell-sub">{l.analytics?.blockedOpens} {t('بعد الإغلاق', 'after it closed')}</div>
                  )}
                </td>
                <td className="mono">
                  {l.stats.sessions}
                  {l.analytics?.openToSession != null && (
                    <div className="cell-sub">{l.analytics.openToSession}% {t('من الفتحات', 'of opens')}</div>
                  )}
                </td>
                <td className="mono">
                  {l.stats.paid} ({l.stats.paid_amount.toLocaleString()})
                  {l.analytics?.sessionToPaid != null && (
                    <div className="cell-sub">{l.analytics.sessionToPaid}% {t('من الجلسات', 'of sessions')}</div>
                  )}
                </td>
                <td>
                  {l.status === 'active' ? t('نشط', 'Active')
                    : l.status === 'expired' ? t('منتهٍ', 'Expired')
                    : l.status === 'exhausted' ? t('مستنفَد', 'Exhausted')
                    : t('موقوف', 'Disabled')}
                </td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void copyUrl(l)}>{copied === l.id ? '✓' : t('نسخ', 'Copy')}</button>
                  <button className="btn-ghost" onClick={() => setExpanded(expanded === l.id ? null : l.id)}>
                    {expanded === l.id ? t('إخفاء', 'Hide') : t('تحليلات', 'Analytics')}
                  </button>
                  {can('checkout-builder', 'can_create') && (
                    <button className="btn-ghost" onClick={() => void duplicate(l)}>{t('نسخة', 'Duplicate')}</button>
                  )}
                  {can('checkout-builder', 'can_edit') && (
                    <>
                      <button className="btn-ghost" onClick={() => void toggle(l)}>{l.active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>
                      {l.status !== 'expired' && (
                        <button className="btn-ghost danger" onClick={() => void expire(l)}>{t('إنهاء', 'Expire')}</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
              {expanded === l.id && (
                <tr>
                  <td colSpan={9}>
                    {!l.analytics ? (
                      <span className="cell-sub">{t('لا توجد بيانات لهذا الرابط بعد.', 'No data for this link yet.')}</span>
                    ) : (
                      <div className="kpi-grid">
                        <div className="kpi-card">
                          <div className="kpi-value">{l.analytics.opens}</div>
                          <div className="kpi-label">{t('فتحات', 'Opens')}</div>
                          <div className="cell-sub">{l.analytics.visitors} {t('زائر مميّز/يوم', 'distinct visitors/day')}</div>
                        </div>
                        <div className="kpi-card">
                          <div className="kpi-value">{l.analytics.openToSession == null ? '—' : `${l.analytics.openToSession}%`}</div>
                          <div className="kpi-label">{t('فتحة ← جلسة', 'Open → session')}</div>
                          <div className="cell-sub">{t('كم من الزوّار بدأ الدفع', 'how many visitors started paying')}</div>
                        </div>
                        <div className="kpi-card">
                          <div className="kpi-value">{l.analytics.sessionToPaid == null ? '—' : `${l.analytics.sessionToPaid}%`}</div>
                          <div className="kpi-label">{t('جلسة ← دفع', 'Session → paid')}</div>
                          <div className="cell-sub">{t('كم منهم أكمل', 'how many of those finished')}</div>
                        </div>
                        <div className="kpi-card">
                          <div className="kpi-value mono">{l.analytics.methods[0]?.method ?? '—'}</div>
                          <div className="kpi-label">{t('الطريقة الأكثر استخداماً', 'Most used method')}</div>
                          <div className="cell-sub">{l.analytics.methods[0]?.uses ?? 0} {t('مرة', 'times')}</div>
                        </div>
                      </div>
                    )}
                    {l.analytics && l.analytics.methods.length > 0 && (
                      <div className="chip-row">
                        {l.analytics.methods.map((m) => (
                          <span key={m.method} className="pay-status-badge st-dim">
                            {m.method}: {m.uses} ({m.paid} {t('مدفوعة', 'paid')})
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {!links.length && <tr><td colSpan={9} className="empty">{t('لا توجد روابط بعد', 'No links yet')}</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  )
}
