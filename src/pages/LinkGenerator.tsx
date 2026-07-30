import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'

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
      setError(err instanceof ApiError && err.status === 403 ? 'دورك لا يملك صلاحية عرض روابط الدفع' : 'تعذر تحميل الروابط')
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
      setError(err instanceof ApiError && err.status === 403 ? 'دورك لا يملك صلاحية إنشاء روابط' : 'تعذر إنشاء الرابط')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (link: PaymentLink) => {
    try {
      await api(`/api/links/${link.id}`, { method: 'PATCH', body: JSON.stringify({ active: !link.active }) })
      await load()
    } catch {
      setError('تعذر تعديل الرابط')
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
      <h2>مولد روابط الدفع</h2>
      <div className="kpis">
        <div className="kpi"><b>{totals.links}</b><span>رابط</span></div>
        <div className="kpi"><b>{totals.sessions}</b><span>جلسة</span></div>
        <div className="kpi"><b>{totals.paid}</b><span>مدفوعة</span></div>
        <div className="kpi"><b className="mono">{totals.amount.toLocaleString()}</b><span>إجمالي مدفوع</span></div>
      </div>

      {can('checkout-builder', 'can_create') && (
        <form className="card link-form" onSubmit={create}>
          <div className="grid-3">
            <label className="field"><span>العنوان</span>
              <input value={form.title} onChange={set('title')} placeholder="مثال: إيداع عميل VIP" /></label>
            <label className="field"><span>التاجر</span>
              <select value={form.merchant_id} onChange={set('merchant_id')}>
                <option value="">— بدون تاجر —</option>
                {merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select></label>
            <label className="field"><span>نوع المبلغ</span>
              <select value={form.amount_mode} onChange={set('amount_mode')}>
                <option value="open">مفتوح</option>
                <option value="fixed">ثابت</option>
              </select></label>
            {form.amount_mode === 'fixed' ? (
              <label className="field"><span>المبلغ (EGP)</span>
                <input dir="ltr" inputMode="decimal" value={form.amount} onChange={set('amount')} required /></label>
            ) : (
              <>
                <label className="field"><span>حد أدنى</span>
                  <input dir="ltr" inputMode="decimal" value={form.min_amount} onChange={set('min_amount')} /></label>
                <label className="field"><span>حد أقصى</span>
                  <input dir="ltr" inputMode="decimal" value={form.max_amount} onChange={set('max_amount')} /></label>
              </>
            )}
            <label className="field"><span>تاريخ الانتهاء</span>
              <input type="datetime-local" dir="ltr" value={form.expires_at} onChange={set('expires_at')} /></label>
            <label className="field"><span>حد الاستخدامات</span>
              <input dir="ltr" inputMode="numeric" value={form.max_uses} onChange={set('max_uses')} /></label>
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="btn-primary" disabled={busy}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء رابط'}</button>
        </form>
      )}

      <div className="card table-card">
        <table className="links-table">
          <thead>
            <tr><th>الكود</th><th>العنوان</th><th>المبلغ</th><th>الاستخدام</th><th>جلسات</th><th>مدفوع</th><th>الحالة</th><th /></tr>
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
                <td>{l.active ? 'نشط' : 'موقوف'}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void copyUrl(l)}>{copied === l.id ? '✓' : 'نسخ'}</button>
                  {can('checkout-builder', 'can_edit') && (
                    <button className="btn-ghost" onClick={() => void toggle(l)}>{l.active ? 'إيقاف' : 'تفعيل'}</button>
                  )}
                </td>
              </tr>
            ))}
            {!links.length && <tr><td colSpan={8} className="empty">لا توجد روابط بعد</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  )
}
