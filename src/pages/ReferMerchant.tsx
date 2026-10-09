import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

// Public merchant-referral landing page — opened from a staff member's
// personal referral link (see Merchants.tsx's "Refer new merchants" card
// and server/referrals.ts). No auth: the link's own HS256 token is the
// only credential here, same trust model as the checkout/payout links.

interface LandingInfo { referrer_name: string }

const referErrors: Record<string, [string, string]> = {
  invalid_or_expired_link: ['هذا الرابط غير صالح أو منتهي الصلاحية', 'This link is invalid or has expired'],
  business_name_required: ['اسم النشاط التجاري مطلوب', 'Business name is required'],
}

export default function ReferMerchant() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [info, setInfo] = useState<LandingInfo | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [contactName, setContactName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!token) { setLinkError(t('رابط الإحالة غير مكتمل', 'This referral link is incomplete')); setLoaded(true); return }
    api<LandingInfo>(`/api/referrals/landing?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((err) => setLinkError(err instanceof ApiError && referErrors[err.code] ? t(...referErrors[err.code]) : t('تعذّر تحميل الرابط', 'Failed to load the link')))
      .finally(() => setLoaded(true))
  }, [token])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api('/api/referrals/leads', {
        method: 'POST',
        body: JSON.stringify({ token, business_name: businessName, contact_name: contactName || undefined, phone: phone || undefined, email: email || undefined, notes: notes || undefined }),
      })
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError && referErrors[err.code] ? t(...referErrors[err.code]) : t('تعذّر إرسال الطلب — حاول مرة أخرى', 'Could not submit — try again'))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <div className="pay-wrap checkout-loader-wrap">
        <div className="checkout-loader"><div className="checkout-loader-logo">On Target</div><div className="checkout-loader-track" /></div>
      </div>
    )
  }

  if (linkError) {
    return (
      <div className="pay-wrap checkout-state-wrap">
        <div>
          <div className="checkout-state-icon">⚠️</div>
          <div className="checkout-state-title">{t('تعذّر تحميل رابط الإحالة', 'Unable to load this referral link')}</div>
          <div className="checkout-state-msg">{linkError}</div>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="pay-wrap">
        <div className="card pay-card checkout-card payout-request-done-card">
          <div className="checkout-proof-done">
            <span>✓</span>
            <div>
              <strong>{t('تم استلام طلبك', 'Your referral was received')}</strong>
              <p>{t('سيتواصل معك فريقنا قريباً لاستكمال الانضمام.', "Our team will reach out soon to complete onboarding.")}</p>
            </div>
          </div>
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
            <div className="checkout-amount-label">{t('انضم كتاجر', 'Become a merchant')}</div>
            <div className="checkout-gold-line" />
            {info?.referrer_name && <p className="checkout-form-sub">{t('بدعوة من', 'Referred by')} <b>{info.referrer_name}</b></p>}
            <p className="checkout-form-sub">{t('أخبرنا عن نشاطك التجاري وسنتواصل معك لاستكمال الإعداد وربط قناة التحصيل.', "Tell us about your business and we'll follow up to finish setup and connect a collection channel.")}</p>
          </div>
          <div className="checkout-right">
            <form onSubmit={onSubmit}>
              <h2 className="checkout-form-title">{t('بيانات النشاط التجاري', 'Business details')}</h2>
              <label className="login-field">
                <span className="login-label">{t('اسم النشاط التجاري', 'Business name')}</span>
                <input className="login-input" required value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
              </label>
              <label className="login-field">
                <span className="login-label">{t('اسم المسؤول', 'Contact name')}</span>
                <input className="login-input" value={contactName} onChange={(e) => setContactName(e.target.value)} />
              </label>
              <label className="login-field">
                <span className="login-label">{t('الهاتف', 'Phone')}</span>
                <input className="login-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <label className="login-field">
                <span className="login-label">{t('البريد الإلكتروني', 'Email')}</span>
                <input className="login-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="login-field">
                <span className="login-label">{t('ملاحظات', 'Notes')}</span>
                <input className="login-input" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              {error && <div className="login-error">{error}</div>}
              <button className="login-btn" disabled={busy || !businessName.trim()}>{busy ? t('جارٍ الإرسال…', 'Submitting…') : t('إرسال', 'Submit')}</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
