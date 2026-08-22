import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

interface PayLink {
  short_code: string
  title: string | null
  amount_mode: 'fixed' | 'open'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
  currency: string
}

export interface PaySession {
  id: string
  reference: string
  status: string
  amount: number
  currency: string
  customer_phone: string | null
  wallet_number: string | null
  provider: string | null
  channel_name: string | null
  deeplink: string | null
  expires_at: string
  created_at: string
  paid_at: string | null
}

// Provider string -> the theme key the stylesheet defines. Matching on
// substrings rather than exact equality because the value arrives from the
// channel configuration and is not a closed enum; an unrecognised provider
// simply gets no key and the card keeps the neutral accent.
export function providerTheme(provider: string | null, channel: string | null): string | null {
  const v = `${provider ?? ''} ${channel ?? ''}`.toLowerCase()
  if (!v.trim()) return null
  if (v.includes('vodafone') || v.includes('vf')) return 'vodafone-cash'
  if (v.includes('orange')) return 'orange-cash'
  if (v.includes('instapay') || v.includes('ipn')) return 'instapay'
  if (v.includes('fawry')) return 'fawry'
  if (v.includes('valu')) return 'valu'
  if (v.includes('masary')) return 'masary'
  if (v.includes('bee')) return 'bee'
  if (v.includes('etisalat') || v.includes('etissalat')) return 'etisalat'
  if (v.includes('we pay') || v.includes('we-pay') || v.includes('wepay')) return 'we-pay'
  if (v.includes('bank') || v.includes('transfer')) return 'bank'
  return null
}

// Thousands separators for display only. The value kept in state stays a bare
// numeric string, because the separator characters must never reach the API.
// Decorative marks only — deliberately not the providers' real logos, which
// would mean redistributing their trademarked artwork on a page that takes
// money. aria-hidden because they carry no information the text does not.
function PayOrbit() {
  const marks = [
    { at: { top: '12%', insetInlineStart: '10%' }, glyph: '💳', delay: '0s' },
    { at: { top: '22%', insetInlineEnd: '12%' }, glyph: '🟠', delay: '2.4s' },
    { at: { bottom: '26%', insetInlineStart: '14%' }, glyph: '🔴', delay: '4.8s' },
    { at: { bottom: '16%', insetInlineEnd: '16%' }, glyph: '🔵', delay: '7.2s' },
  ]
  return (
    <div className="pay-orbit" aria-hidden="true">
      {marks.map((m, i) => (
        <i key={i} style={{ ...m.at, animationDelay: m.delay }}>{m.glyph}</i>
      ))}
    </div>
  )
}

function groupDigits(raw: string): string {
  const [whole, ...rest] = raw.split('.')
  if (!whole) return raw
  return [whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','), ...rest].join('.')
}

export function providerLabel(provider: string | null, fallback: string | null): string {
  if (!provider) return fallback ?? ''
  return provider.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function BrandBar({ merchant, t }: { merchant: string | null; t: (a: string, e: string) => string }) {
  return (
    <div className="pay-brandbar">
      {t('بدعم من', 'Powered by')} <b>OnTarget</b>
      {merchant ? <>· {t('لصالح', 'for')} <b>{merchant}</b></> : null}
    </div>
  )
}

const payErrors: Record<string, [string, string]> = {
  invalid_phone: ['أدخل رقم موبايل مصري صحيح (01xxxxxxxxx)', 'Enter a valid Egyptian mobile (01xxxxxxxxx)'],
  invalid_amount: ['أدخل مبلغاً صحيحاً', 'Enter a valid amount'],
  link_not_found: ['رابط الدفع غير موجود', 'Payment link not found'],
  link_disabled: ['رابط الدفع موقوف', 'Payment link disabled'],
  link_expired: ['انتهت صلاحية رابط الدفع', 'Payment link expired'],
  link_exhausted: ['اكتمل عدد استخدامات هذا الرابط', "This link's usage limit is reached"],
  no_channel_available: ['لا توجد قناة دفع متاحة حالياً — حاول لاحقاً', 'No payment channel available now — try later'],
  amount_below_min: ['المبلغ أقل من الحد الأدنى', 'Amount is below the minimum'],
  amount_above_max: ['المبلغ أكبر من الحد الأقصى', 'Amount is above the maximum'],
}

export default function PaymentCheckout() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  const code = params.get('code')
  const [link, setLink] = useState<PayLink | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<PaySession | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!code) return
    api<{ link: PayLink }>(`/api/pay/link/${encodeURIComponent(code)}`)
      .then(({ link }) => {
        setLink(link)
        if (link.amount_mode === 'fixed' && link.amount) setAmount(String(link.amount))
      })
      .catch((err) => setLinkError(err instanceof ApiError && payErrors[err.code] ? t(payErrors[err.code][0], payErrors[err.code][1]) : t('تعذر تحميل الرابط', 'Failed to load the link')))
  }, [code])

  useEffect(() => {
    if (!session?.wallet_number) return
    QRCode.toDataURL(session.deeplink ?? session.wallet_number, {
      width: 240,
      margin: 1,
      color: { dark: '#6d28d9', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setQr).catch(() => setQr(null))
  }, [session])

  const copy = async (text: string, tag: string) => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(tag)
    setTimeout(() => setCopied(null), 1500)
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { session } = await api<{ session: PaySession }>('/api/pay/session', {
        method: 'POST',
        body: JSON.stringify({ code, phone, amount: Number(amount), name: name || undefined }),
      })
      setSession(session)
    } catch (err) {
      setError(err instanceof ApiError && payErrors[err.code] ? t(payErrors[err.code][0], payErrors[err.code][1]) : (err instanceof ApiError ? t('حدث خطأ — حاول مرة أخرى', 'An error occurred — try again') : t('تعذر الاتصال بالخادم', 'Failed to reach the server')))
    } finally {
      setBusy(false)
    }
  }

  // Paint the page in the allocated provider's colour. Set on <html> so the
  // backdrop behind the card can react too, and cleared on unmount so the
  // theme never leaks into the panel if the customer navigates onward.
  useEffect(() => {
    const key = session ? providerTheme(session.provider, session.channel_name) : null
    const root = document.documentElement
    if (key) root.dataset.payTheme = key
    else delete root.dataset.payTheme
    return () => { delete root.dataset.payTheme }
  }, [session])

  if (linkError) {
    return (
      <div className="pay-wrap"><div className="card pay-card"><h2>⚠️ {linkError}</h2></div></div>
    )
  }

  if (session) {
    const pLabel = providerLabel(session.provider, session.channel_name)
    return (
      <div className="pay-wrap">
        <PayOrbit />
        <BrandBar merchant={link?.title ?? null} t={t} />
        <div className="card pay-card">
          <img src="/logo.svg" alt="OnTarget" className="login-logo" />
          <p className="login-sub">{t('حوّل المبلغ من محفظتك إلى الرقم التالي', 'Transfer the amount from your wallet to the number below')}</p>
          <div className="pay-amount">{session.amount} <span>{session.currency}</span></div>
          <div className="pay-channel">{pLabel}</div>
          <div className="pay-wallet mono">{session.wallet_number}</div>
          {qr && <img src={qr} alt="QR" className="pay-qr" />}
          <div className="pay-actions">
            <button className="btn-primary" onClick={() => void copy(session.wallet_number ?? '', 'wallet')}>
              {copied === 'wallet' ? t('✓ تم النسخ', '✓ Copied') : t('نسخ رقم المحفظة', 'Copy wallet number')}
            </button>
            {session.deeplink && (
              <a className="btn-primary" href={session.deeplink}>{t('فتح التطبيق', 'Open app')}</a>
            )}
            {qr && (
              <a className="btn-ghost" href={qr} download={`ontarget-${session.reference}.png`}>{t('تحميل QR', 'Download QR')}</a>
            )}
            <button
              className="btn-ghost"
              onClick={() => void copy(`${location.origin}/payment-status?id=${session.id}`, 'status')}
            >
              {copied === 'status' ? t('✓ تم النسخ', '✓ Copied') : t('نسخ رابط المتابعة', 'Copy tracking link')}
            </button>
          </div>
          <p className="pay-note">
            {t('المرجع', 'Reference')}: <span className="mono">{session.reference}</span> · {t('صالح حتى', 'valid until')}{' '}
            {new Date(session.expires_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
          </p>
          <Link className="btn-ghost pay-status-link" to={`/payment-status?id=${session.id}`}>
            {t('متابعة حالة الدفع ←', 'Track payment status →')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="pay-wrap">
      <PayOrbit />
      <BrandBar merchant={link?.title ?? null} t={t} />
      <form className="card pay-card" onSubmit={onSubmit}>
        <img src="/logo.svg" alt="OnTarget" className="login-logo" />
        <h2>{link?.title ?? t('إيداع جديد', 'New deposit')}</h2>
        <p className="login-sub">{t('ادفع عبر المحفظة الإلكترونية', 'Pay via your mobile wallet')}</p>
        <label className="field">
          <span>{t('رقم الموبايل', 'Mobile number')}</span>
          {/* type="tel" as well as inputMode: inputMode alone still asks some
              Android keyboards for the full QWERTY layout, and the wallet
              number is the very first thing a paying customer types. Digits
              only, capped at the 11 an Egyptian mobile has. */}
          <input
            type="tel"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="tel"
            maxLength={11}
            dir="ltr"
            placeholder="01012345678"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>{t('الاسم (اختياري)', 'Name (optional)')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {t('المبلغ', 'Amount')} ({link?.currency ?? 'EGP'})
            {link?.amount_mode === 'open' && link.min_amount !== null && ` · ${t('من', 'from')} ${link.min_amount}`}
            {link?.amount_mode === 'open' && link.max_amount !== null && ` ${t('إلى', 'to')} ${link.max_amount}`}
          </span>
          {/* Grouped for reading, ungrouped in state. Stripping on the way in
              means a pasted "5,000" is accepted rather than rejected as
              non-numeric. */}
          <input
            type="tel"
            inputMode="decimal"
            dir="ltr"
            value={groupDigits(amount)}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            readOnly={link?.amount_mode === 'fixed'}
            required
          />
        </label>
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? t('جارٍ التجهيز…', 'Preparing…') : t('متابعة الدفع', 'Continue to payment')}
        </button>
      </form>
    </div>
  )
}
