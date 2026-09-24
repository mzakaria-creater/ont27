import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'
import MethodLogo from '../components/MethodLogo'

interface PayLink {
  short_code: string
  title: string | null
  amount_mode: 'fixed' | 'open'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
  currency: string
  client_name: string | null
  client_reference: string | null
  return_url: string | null
  payment_method_codes: string[]
  allocation_mode: 'single_queue' | 'multi_wallet'
  multi_wallet_threshold: number | null
  require_name: boolean
  merchant_mid?: string | null
  master_mid?: string | null
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
  wallets?: Array<{ walletNumber: string; amount: number; provider: string; device: string }> | null
  return_url?: string | null
  merchant_mid?: string | null
  master_mid?: string | null
  usd_amount?: number | null
  fx_rate_used?: number | null
  customer_proof_url?: string | null
  customer_proof_note?: string | null
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

function isHfmLink(link: PayLink | null): boolean {
  return link?.client_name?.toLowerCase().includes('hfm') === true
}

function checkoutBrandLogo(link: PayLink | null): string {
  return isHfmLink(link) ? '/hfm-logo.svg' : '/logo.svg'
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

// Countdown against the session's own TTL window (created_at → expires_at),
// not a fixed constant — the server owns SESSION_TTL_MIN and could change it.
// Self-ticking so the parent re-renders only once, when the session arrives.
function SessionExpiry({ createdAt, expiresAt, t }: { createdAt: string; expiresAt: string; t: (a: string, e: string) => string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])
  const created = new Date(createdAt).getTime()
  const expiry = new Date(expiresAt).getTime()
  const total = Math.max(expiry - created, 1)
  const left = expiry - now
  const pct = Math.max(0, Math.min(100, (left / total) * 100))
  const urgency = left <= 0 ? '' : pct < 10 ? 'critical' : pct < 25 ? 'warn' : ''
  const m = Math.max(Math.floor(left / 60000), 0)
  const s = Math.max(Math.floor((left % 60000) / 1000), 0)
  return (
    <div className="checkout-expiry">
      <div className="checkout-expiry-label">{t('صالح حتى', 'Session expires in')}</div>
      <div className="checkout-expiry-track"><div className={`checkout-expiry-fill ${urgency}`} style={{ width: `${pct}%` }} /></div>
      <div className="checkout-expiry-time">{left <= 0 ? t('منتهية الصلاحية', 'Expired') : m > 0 ? `${m}${t('د', 'm')} ${String(s).padStart(2, '0')}${t('ث', 's')}` : `${s}${t('ث', 's')}`}</div>
    </div>
  )
}

const sessionStatusLabel: Record<string, [string, string]> = {
  pending: ['بانتظار التحويل', 'Awaiting transfer'],
  processing: ['جارٍ التحقق', 'Verifying'],
  approved: ['تم الدفع', 'Paid'],
  declined: ['مرفوض', 'Declined'],
  expired: ['منتهية الصلاحية', 'Expired'],
}

const payErrors: Record<string, [string, string]> = {
  invalid_phone: ['أدخل رقم موبايل مصري صحيح (01xxxxxxxxx)', 'Enter a valid Egyptian mobile (01xxxxxxxxx)'],
  invalid_amount: ['أدخل مبلغاً صحيحاً', 'Enter a valid amount'],
  link_not_found: ['رابط الدفع غير موجود', 'Payment link not found'],
  link_disabled: ['رابط الدفع موقوف', 'Payment link disabled'],
  link_expired: ['انتهت صلاحية رابط الدفع', 'Payment link expired'],
  link_exhausted: ['اكتمل عدد استخدامات هذا الرابط', "This link's usage limit is reached"],
  name_required: ['هذا الرابط يتطلب إدخال الاسم', 'This link requires your name'],
  myhfm_account_required: ['رقم حساب MYHFM مطلوب', 'MYHFM account number is required'],
  no_channel_available: ['لا توجد قناة دفع متاحة حالياً — حاول لاحقاً', 'No payment channel available now — try later'],
  amount_below_min: ['المبلغ أقل من الحد الأدنى', 'Amount is below the minimum'],
  amount_above_max: ['المبلغ أكبر من الحد الأقصى', 'Amount is above the maximum'],
  payment_method_not_allowed: ['طريقة الدفع غير متاحة لهذا الرابط', 'This payment method is not available for this link'],
}

export default function PaymentCheckout() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  // New links use a 64-hex, 256-bit token. Keep short_code as a backwards
  // compatible fallback for links created before the secure-token migration.
  const token = params.get('token')
  const code = params.get('code')
  const linkKey = token || code
  const [link, setLink] = useState<PayLink | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [myhfmAccount, setMyhfmAccount] = useState('')
  const [amount, setAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<PaySession | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [idempotencyKey] = useState(() => `checkout-${crypto.randomUUID()}`)
  const [rate, setRate] = useState<number | null>(null)
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [proofNote, setProofNote] = useState('')
  const [proofBusy, setProofBusy] = useState(false)
  const [proofError, setProofError] = useState<string | null>(null)

  useEffect(() => {
    if (!linkKey) return
    api<{ link: PayLink }>(`/api/pay/link/${encodeURIComponent(linkKey)}`)
      .then(({ link }) => {
        setLink(link)
        if (link.amount_mode === 'fixed' && link.amount) setAmount(String(link.amount))
      })
      .catch((err) => setLinkError(err instanceof ApiError && payErrors[err.code] ? t(payErrors[err.code][0], payErrors[err.code][1]) : t('تعذر تحميل الرابط', 'Failed to load the link')))
  }, [linkKey])

  // Only USD-denominated links need a rate — wallets, matching, and every
  // admin view assume EGP, so this is display-only here; the server converts
  // for real (and re-checks the rate) at session creation.
  useEffect(() => {
    if (link?.currency !== 'USD') return
    api<{ rate: number }>('/api/pay/rate').then((r) => setRate(r.rate)).catch(() => setRate(null))
  }, [link?.currency])

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
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ code: linkKey, phone, amount: Number(amount), name: name || undefined, myhfm_account: myhfmAccount || undefined, payment_method_code: paymentMethod || undefined, idempotency_key: idempotencyKey }),
      })
      setSession(session)
    } catch (err) {
      setError(err instanceof ApiError && payErrors[err.code] ? t(payErrors[err.code][0], payErrors[err.code][1]) : (err instanceof ApiError ? t('حدث خطأ — حاول مرة أخرى', 'An error occurred — try again') : t('تعذر الاتصال بالخادم', 'Failed to reach the server')))
    } finally {
      setBusy(false)
    }
  }

  const submitProof = async (e: FormEvent) => {
    e.preventDefault()
    if (!session || !proofFile) return
    setProofBusy(true)
    setProofError(null)
    try {
      const form = new FormData()
      form.set('file', proofFile)
      if (proofNote.trim()) form.set('note', proofNote.trim())
      const { session: updated } = await api<{ session: PaySession }>(`/api/pay/session/${session.id}/proof`, { method: 'POST', body: form })
      setSession(updated)
    } catch (err) {
      setProofError(err instanceof ApiError && err.code === 'session_expired' ? t('انتهت صلاحية الجلسة.', 'The session has expired.') : t('تعذّر رفع الإثبات — حاول مرة أخرى.', 'Failed to upload proof — try again.'))
    } finally {
      setProofBusy(false)
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
      <div className="pay-wrap checkout-state-wrap">
        <div>
          <div className="checkout-state-icon">⚠️</div>
          <div className="checkout-state-title">{t('تعذّر تحميل رابط الدفع', 'Unable to load this link')}</div>
          <div className="checkout-state-msg">{linkError}</div>
        </div>
      </div>
    )
  }

  // linkKey present but the fetch hasn't resolved yet. No linkKey at all is a
  // deliberately supported code-less mode (see onSubmit), so that case falls
  // straight through to the form below instead of loading forever.
  if (linkKey && !link) {
    return (
      <div className="pay-wrap checkout-loader-wrap">
        <div className="checkout-loader">
          <div className="checkout-loader-logo">On Target</div>
          <div className="checkout-loader-track" />
        </div>
      </div>
    )
  }

  if (session) {
    const pLabel = providerLabel(session.provider, session.channel_name)
    return (
      <div className="pay-wrap">
        <PayOrbit />
        <BrandBar merchant={link?.title ?? null} t={t} />
        <div className="card pay-card checkout-card">
          <div className="checkout-split">
            <div className="checkout-left">
              <img src={checkoutBrandLogo(link)} alt={link?.client_name ?? 'OnTarget'} className="login-logo" />
              <div className="checkout-amount-label">{t('المبلغ المطلوب', 'Amount due')}</div>
              <div className="checkout-amount"><span className="checkout-amount-cur">{session.currency}</span><span className="checkout-amount-num">{groupDigits(String(session.amount))}</span></div>
              <div className="checkout-gold-line" />
              <div className="checkout-detail-row"><span>{t('المرجع', 'Reference')}</span><span className="mono hi">{session.reference}</span></div>
              {(session.merchant_mid || session.master_mid) && <div className="checkout-detail-row"><span>MID</span><span className="mono">{session.merchant_mid ?? session.master_mid}</span></div>}
              <div className="checkout-detail-row"><span>{t('الحالة', 'Status')}</span><span className={`checkout-status-badge is-${session.status}`}>{t(...(sessionStatusLabel[session.status] ?? sessionStatusLabel.pending))}</span></div>
              <SessionExpiry createdAt={session.created_at} expiresAt={session.expires_at} t={t} />
              <div className="checkout-security"><LockIcon /> {t('اتصال مشفّر 256-bit · دفع آمن', '256-bit SSL encrypted · Secure payment')}</div>
            </div>
            <div className="checkout-right">
              <h2 className="checkout-form-title">{t('أكمل التحويل', 'Complete the transfer')}</h2>
              <p className="checkout-form-sub">{t('حوّل المبلغ من محفظتك إلى الرقم التالي', 'Transfer the amount from your wallet to the number below')}</p>
              <div className="pay-channel">{pLabel}</div>
              {session.wallets?.length ? <div className="pay-wallet-list">{session.wallets.map((wallet) => <div key={`${wallet.walletNumber}-${wallet.device}`}><span className="mono">{wallet.walletNumber}</span><strong>{wallet.amount} {session.currency}</strong><small>{providerLabel(wallet.provider, wallet.device)}</small></div>)}</div> : <div className="pay-wallet mono">{session.wallet_number}</div>}
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
              <Link className="btn-ghost pay-status-link" to={`/payment-status?id=${session.id}`}>
                {t('متابعة حالة الدفع ←', 'Track payment status →')}
              </Link>
              {session.return_url && <a className="btn-ghost pay-status-link" href={session.return_url}>{t('العودة إلى التاجر', 'Return to merchant')}</a>}

              <div className="checkout-proof-block">
                {session.customer_proof_url ? (
                  <div className="checkout-proof-done">
                    <span>✓</span>
                    <div>
                      <strong>{t('تم استلام إثبات الدفع', 'Proof received')}</strong>
                      <p>{t('سيتم مراجعتها والتأكيد قريباً.', "It'll be reviewed and confirmed shortly.")}</p>
                    </div>
                  </div>
                ) : (
                  <form className="checkout-proof-form" onSubmit={submitProof}>
                    <h3>{t('بعد التحويل، ارفع إثبات الدفع', 'After transferring, upload your proof')}</h3>
                    <label className="field">
                      <span>{t('صورة الإثبات', 'Proof screenshot')}</span>
                      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} required />
                    </label>
                    <label className="field">
                      <span>{t('ملاحظة (اختياري)', 'Note (optional)')}</span>
                      <input value={proofNote} onChange={(e) => setProofNote(e.target.value)} />
                    </label>
                    {proofError && <div className="login-error" role="alert">{proofError}</div>}
                    <button className="btn-primary checkout-submit" type="submit" disabled={proofBusy || !proofFile}>
                      {proofBusy ? t('جارٍ الرفع…', 'Uploading…') : t('إرسال إثبات الدفع', 'Submit payment proof')}
                    </button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pay-wrap">
      <PayOrbit />
      <BrandBar merchant={link?.title ?? null} t={t} />
      <div className="card pay-card checkout-card">
        <div className="checkout-split">
          <div className="checkout-left">
            <img src={checkoutBrandLogo(link)} alt={link?.client_name ?? 'OnTarget'} className="login-logo" />
            <div className="checkout-amount-label">{t('المبلغ', 'Amount')}</div>
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
            {link?.currency === 'USD' && rate != null && (
              <div className="checkout-fx-note">
                {link.amount_mode === 'fixed' && link.amount != null
                  ? `≈ ${groupDigits((link.amount * rate).toFixed(2))} EGP`
                  : `${t('سعر الصرف', 'Rate')}: 1 USD ≈ ${rate.toLocaleString('en-US')} EGP`}
              </div>
            )}
            <div className="checkout-gold-line" />
            {link?.title && <div className="checkout-detail-row"><span>{t('عن', 'About')}</span><span>{link.title}</span></div>}
            {link?.client_name && <div className="checkout-detail-row"><span>{t('لصالح', 'For')}</span><span>{link.client_name}</span></div>}
            <div className="checkout-security"><LockIcon /> {t('اتصال مشفّر 256-bit · دفع آمن', '256-bit SSL encrypted · Secure payment')}</div>
          </div>
          <div className="checkout-right">
            <form onSubmit={onSubmit}>
              <h2 className="checkout-form-title">{link?.title ?? t('إيداع جديد', 'New deposit')}</h2>
              <p className="checkout-form-sub">{t('ادفع عبر المحفظة الإلكترونية', 'Pay via your mobile wallet')}</p>
              {link?.payment_method_codes?.length ? (
                <div className="checkout-method-field" role="radiogroup" aria-label={t('طريقة الدفع', 'Payment method')}>
                  <span className="checkout-method-label">{t('طريقة الدفع', 'Payment method')}</span>
                  <div className="checkout-method-grid">
                    {link.payment_method_codes.map((method) => (
                      <button
                        key={method}
                        type="button"
                        role="radio"
                        aria-checked={paymentMethod === method}
                        className={`checkout-method-tile${paymentMethod === method ? ' is-selected' : ''}`}
                        onClick={() => setPaymentMethod(method)}
                      >
                        <MethodLogo method={method} />
                        <span>{providerLabel(method, method)}</span>
                      </button>
                    ))}
                  </div>
                  {/* Native required field kept invisible for form validation/keyboard users — the tiles above are the real control. */}
                  <select className="checkout-method-native" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} required aria-hidden="true" tabIndex={-1}>
                    <option value="">{t('اختر طريقة الدفع', 'Choose a payment method')}</option>
                    {link.payment_method_codes.map((method) => <option key={method} value={method}>{providerLabel(method, method)}</option>)}
                  </select>
                </div>
              ) : null}
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
                <span>{link?.require_name ? t('الاسم', 'Name') : t('الاسم (اختياري)', 'Name (optional)')}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required={link?.require_name === true} />
              </label>
              {isHfmLink(link) && (
                <label className="field">
                  <span>{t('رقم حساب MYHFM', 'MYHFM account number')}</span>
                  <input dir="ltr" value={myhfmAccount} onChange={(e) => setMyhfmAccount(e.target.value)} placeholder="e.g. 123456" required />
                </label>
              )}
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
                {link?.currency === 'USD' && rate != null && Number(amount) > 0 && (
                  <small className="checkout-fx-note">≈ {groupDigits((Number(amount) * rate).toFixed(2))} EGP</small>
                )}
              </label>
              {error && <div className="login-error" role="alert">{error}</div>}
              <button className="btn-primary checkout-submit" type="submit" disabled={busy}>
                {busy ? t('جارٍ التجهيز…', 'Preparing…') : t('متابعة الدفع', 'Continue to payment')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
