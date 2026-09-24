import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

// Public payout-request page — the outbound counterpart of
// PaymentCheckout. A client fills this in and submits a REQUEST; nothing
// here moves money. The request lands in payout_link_requests as
// 'pending' and only becomes a real payout once an authenticated
// operator reviews and converts it (see server/payoutRequests.ts).

interface PayoutLink {
  short_code: string
  title: string | null
  client_name: string | null
  currency: string
  amount_mode: 'fixed' | 'open'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
}

interface PayoutRequestResult {
  id: string
  reference: string
  amount: number
  currency: string
  status: string
  created_at: string
}

const payoutErrors: Record<string, [string, string]> = {
  link_not_found: ['رابط السحب غير موجود', 'Payout link not found'],
  link_disabled: ['رابط السحب موقوف', 'Payout link disabled'],
  link_expired: ['انتهت صلاحية رابط السحب', 'Payout link expired'],
  link_exhausted: ['اكتمل عدد استخدامات هذا الرابط', "This link's usage limit is reached"],
  myhfm_account_required: ['رقم حساب MYHFM مطلوب', 'MYHFM account number is required'],
  invalid_wallet: ['أدخل رقم محفظة مصري صحيح (01xxxxxxxxx)', 'Enter a valid Egyptian wallet number (01xxxxxxxxx)'],
  invalid_amount: ['أدخل مبلغاً صحيحاً', 'Enter a valid amount'],
  amount_below_min: ['المبلغ أقل من الحد الأدنى', 'Amount is below the minimum'],
  amount_above_max: ['المبلغ أكبر من الحد الأقصى', 'Amount is above the maximum'],
}

function groupDigits(raw: string): string {
  const [whole, ...rest] = raw.split('.')
  if (!whole) return raw
  return [whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','), ...rest].join('.')
}

export default function PayoutCheckout() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  const token = params.get('token')
  const code = params.get('code')
  const linkKey = token || code
  const [link, setLink] = useState<PayoutLink | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkLoaded, setLinkLoaded] = useState(false)
  const [myhfmAccount, setMyhfmAccount] = useState('')
  const [receiverName, setReceiverName] = useState('')
  const [receiverWallet, setReceiverWallet] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PayoutRequestResult | null>(null)

  useEffect(() => {
    if (!linkKey) { setLinkLoaded(true); return }
    api<{ link: PayoutLink }>(`/api/pay/payout-link/${encodeURIComponent(linkKey)}`)
      .then(({ link }) => {
        setLink(link)
        if (link.amount_mode === 'fixed' && link.amount) setAmount(String(link.amount))
      })
      .catch((err) => setLinkError(err instanceof ApiError && payoutErrors[err.code] ? t(...payoutErrors[err.code]) : t('تعذر تحميل الرابط', 'Failed to load the link')))
      .finally(() => setLinkLoaded(true))
  }, [linkKey])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { request } = await api<{ request: PayoutRequestResult }>('/api/pay/payout-session', {
        method: 'POST',
        body: JSON.stringify({
          code: linkKey,
          myhfm_account: myhfmAccount,
          receiver_name: receiverName || undefined,
          receiver_wallet: receiverWallet,
          amount: Number(amount),
          note: note || undefined,
        }),
      })
      setResult(request)
    } catch (err) {
      setError(err instanceof ApiError && payoutErrors[err.code] ? t(...payoutErrors[err.code]) : t('تعذر إرسال الطلب — حاول مرة أخرى', 'Could not submit the request — try again'))
    } finally {
      setBusy(false)
    }
  }

  if (linkError) {
    return (
      <div className="pay-wrap checkout-state-wrap">
        <div>
          <div className="checkout-state-icon">⚠️</div>
          <div className="checkout-state-title">{t('تعذّر تحميل رابط السحب', 'Unable to load this link')}</div>
          <div className="checkout-state-msg">{linkError}</div>
        </div>
      </div>
    )
  }

  if (linkKey && !linkLoaded) {
    return (
      <div className="pay-wrap checkout-loader-wrap">
        <div className="checkout-loader">
          <div className="checkout-loader-logo">On Target</div>
          <div className="checkout-loader-track" />
        </div>
      </div>
    )
  }

  if (result) {
    return (
      <div className="pay-wrap">
        <div className="card pay-card checkout-card payout-request-done-card">
          <div className="checkout-proof-done">
            <span>✓</span>
            <div>
              <strong>{t('تم استلام طلب السحب', 'Payout request received')}</strong>
              <p>{t('سيتم مراجعته والموافقة عليه يدوياً قبل التنفيذ.', "It'll be manually reviewed and approved before execution.")}</p>
            </div>
          </div>
          <div className="checkout-detail-row"><span>{t('المرجع', 'Reference')}</span><span className="mono hi">{result.reference}</span></div>
          <div className="checkout-detail-row"><span>{t('المبلغ', 'Amount')}</span><span className="mono">{groupDigits(String(result.amount))} {result.currency}</span></div>
          <div className="checkout-detail-row"><span>{t('الحالة', 'Status')}</span><span className="checkout-status-badge is-pending">{t('قيد المراجعة', 'Pending review')}</span></div>
        </div>
      </div>
    )
  }

  return (
    <div className="pay-wrap">
      <div className="card pay-card checkout-card">
        <div className="checkout-split">
          <div className="checkout-left">
            <img src="/logo.svg" alt="OnTarget" className="login-logo" />
            <div className="checkout-amount-label">{t('طلب سحب', 'Payout request')}</div>
            <div className="checkout-amount">
              <span className="checkout-amount-cur">{link?.currency ?? 'EGP'}</span>
              <span className="checkout-amount-num">
                {link?.amount_mode === 'fixed' && link.amount != null
                  ? groupDigits(String(link.amount))
                  : link?.min_amount != null || link?.max_amount != null
                    ? `${link?.min_amount ?? '∗'}–${link?.max_amount ?? '∗'}`
                    : t('مفتوح', 'Open')}
              </span>
            </div>
            <div className="checkout-gold-line" />
            {link?.title && <div className="checkout-detail-row"><span>{t('عن', 'About')}</span><span>{link.title}</span></div>}
            {link?.client_name && <div className="checkout-detail-row"><span>{t('لصالح', 'For')}</span><span>{link.client_name}</span></div>}
            <p className="checkout-form-sub payout-request-note">{t('هذا الطلب لا يحرّك أي أموال فوراً — يحتاج مراجعة وموافقة يدوية أولاً.', 'This request does not move money immediately — it needs manual review and approval first.')}</p>
          </div>
          <div className="checkout-right">
            <form onSubmit={onSubmit}>
              <h2 className="checkout-form-title">{link?.title ?? t('طلب سحب جديد', 'New payout request')}</h2>
              <p className="checkout-form-sub">{t('أدخل بياناتك لاستلام المبلغ', 'Enter your details to receive the amount')}</p>
              <label className="field field-hfm-account">
                <span>{t('رقم حساب MYHFM', 'MYHFM account number')}</span>
                <input dir="ltr" value={myhfmAccount} onChange={(e) => setMyhfmAccount(e.target.value)} placeholder="e.g. 123456" required autoFocus />
                <small>{t('يُستخدم لمطابقة الطلب بحسابك على MYHFM', 'Used to match this request to your MYHFM account')}</small>
              </label>
              <label className="field">
                <span>{t('الاسم', 'Name')}</span>
                <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} />
              </label>
              <label className="field">
                <span>{t('رقم المحفظة المستلمة', 'Receiving wallet number')}</span>
                <input type="tel" inputMode="numeric" pattern="[0-9]*" dir="ltr" maxLength={11} placeholder="01012345678" value={receiverWallet} onChange={(e) => setReceiverWallet(e.target.value.replace(/\D/g, '').slice(0, 11))} required />
              </label>
              <label className="field">
                <span>
                  {t('المبلغ', 'Amount')} ({link?.currency ?? 'EGP'})
                  {link?.amount_mode === 'open' && link.min_amount !== null && ` · ${t('من', 'from')} ${link.min_amount}`}
                  {link?.amount_mode === 'open' && link.max_amount !== null && ` ${t('إلى', 'to')} ${link.max_amount}`}
                </span>
                <input type="tel" inputMode="decimal" dir="ltr" value={groupDigits(amount)} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} readOnly={link?.amount_mode === 'fixed'} required />
              </label>
              <label className="field">
                <span>{t('ملاحظة (اختياري)', 'Note (optional)')}</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              {error && <div className="login-error" role="alert">{error}</div>}
              <button className="btn-primary checkout-submit" type="submit" disabled={busy}>
                {busy ? t('جارٍ الإرسال…', 'Submitting…') : t('إرسال طلب السحب', 'Submit payout request')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
