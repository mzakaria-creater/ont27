import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

interface LinkStats { sessions: number; paid: number; paid_amount: number }
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
  stats: LinkStats
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

      <div className="card table-card">
        <table className="links-table">
          <thead>
            <tr><th>{t('الكود', 'Code')}</th><th>{t('العنوان', 'Title')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الاستخدام', 'Usage')}</th><th>{t('جلسات', 'Sessions')}</th><th>{t('مدفوع', 'Paid')}</th><th>{t('الحالة', 'Status')}</th><th /></tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} className={l.active ? '' : 'row-dim'}>
                <td className="mono">{l.short_code}</td>
                <td>{l.title ?? '—'}</td>
                <td className="mono" dir="ltr">
                  {l.amount_mode === 'fixed' ? `${l.amount} ${l.currency}` : `${l.min_amount ?? '∗'} – ${l.max_amount ?? '∗'} ${l.currency}`}
                </td>
                <td className="mono" dir="ltr">{l.use_count}{l.max_uses ? ` / ${l.max_uses}` : ''}</td>
                <td className="mono">{l.stats.sessions}</td>
                <td className="mono">{l.stats.paid} ({l.stats.paid_amount.toLocaleString()})</td>
                <td>{l.active ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void copyUrl(l)}>{copied === l.id ? '✓' : t('نسخ', 'Copy')}</button>
                  {can('checkout-builder', 'can_edit') && (
                    <button className="btn-ghost" onClick={() => void toggle(l)}>{l.active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>
                  )}
                </td>
              </tr>
            ))}
            {!links.length && <tr><td colSpan={8} className="empty">{t('لا توجد روابط بعد', 'No links yet')}</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  )
}
