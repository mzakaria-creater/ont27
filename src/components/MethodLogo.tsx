// A small coloured mark per payment method, so the column can be scanned by
// shape and colour instead of read word by word.
//
// These are drawn here, not copies of the providers' actual logos: each is a
// plain rounded tile in the provider's colour carrying one or two letters.
// Shipping the real trademarked artwork would mean redistributing someone
// else's brand assets, and a wrong-but-official-looking logo on a payment row
// is worse than an honest placeholder. The method name still travels next to
// it, so nothing depends on recognising the mark alone.

const MARKS: { test: (m: string) => boolean; label: string; bg: string; fg: string; title: string; image?: string }[] = [
  { test: (m) => m.includes('orange'), label: 'O', bg: '#ff7900', fg: '#000', title: 'Orange Money', image: 'https://cdn.orange.eg/images/PortalOrangeApps/MI-OM-IOS-EG-SQR_2_20260816141650309.png' },
  { test: (m) => m.includes('vodafone') || m.includes('vf'), label: 'V', bg: '#e60000', fg: '#fff', title: 'Vodafone Cash', image: 'https://live.staticflickr.com/3074/3051439462_01e1a0fb1f_b.jpg' },
  { test: (m) => m.includes('etissalat') || m.includes('etisalat') || m.includes('e&'), label: 'e&', bg: '#95c11f', fg: '#000', title: 'Etisalat Cash', image: 'https://logowik.com/content/uploads/images/etisalat-new-20225210.logowik.com.webp' },
  { test: (m) => m.includes('instapay') || m.includes('insta pay'), label: 'IP', bg: '#5d4fb8', fg: '#fff', title: 'InstaPay', image: 'https://play-lh.googleusercontent.com/_ks0_XUbrZOkeiXkjaiZEK1S-j1skuQgF1E8S3ff702CoVyaiGnbfXPK74WjgxMk0Q4v2hlhu8WTHxp52Wq0' },
  { test: (m) => m.includes('payfuture') || m.includes('pay future'), label: 'PF', bg: '#fff', fg: '#111', title: 'PayFuture', image: 'https://www.igamingtoday.com/wp-content/uploads/2024/10/PayFuture.jpeg' },
  { test: (m) => m.includes('we pay') || m.includes('wepay'), label: 'WE', bg: '#7b2d8b', fg: '#fff', title: 'WE Pay', image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/We_logo.svg/3840px-We_logo.svg.png' },
  { test: (m) => m.includes('meeza'), label: 'M', bg: '#0a7a5a', fg: '#fff', title: 'Meeza' },
  { test: (m) => m.includes('bank'), label: '🏦', bg: 'var(--hover-2)', fg: 'var(--text)', title: 'Bank deposit' },
  { test: (m) => m.includes('express'), label: '⚡', bg: 'var(--amber-bg)', fg: 'var(--text)', title: 'Express deposit' },
  { test: (m) => m.includes('wallet') || m.includes('mobile'), label: '📱', bg: 'var(--hover-2)', fg: 'var(--text)', title: 'Mobile wallet' },
]

export default function MethodLogo({ method }: { method: string | null | undefined }) {
  const raw = (method ?? '').trim()
  const m = raw.toLowerCase()
  const hit = raw ? MARKS.find((x) => x.test(m)) : undefined
  const uploadedLogo = useBrandLogo('method', raw)

  // Anything unrecognised — a merchant trading name like "Walid Company LTD"
  // shows up in this column too — falls back to its own first letter rather
  // than being forced into someone else's brand colour.
  const label = hit?.label ?? (raw ? raw.slice(0, 1).toUpperCase() : '—')
  const bg = hit?.bg ?? 'var(--hover-2)'
  const fg = hit?.fg ?? 'var(--text-dim)'

  return (
    <span className="method-cell method-cell-logo-only" title={hit?.title ?? raw} role="img" aria-label={(hit?.title ?? raw) || 'Unknown payment method'}>
      <span className="method-logo" style={{ background: bg, color: fg }} title={hit?.title ?? raw} aria-hidden="true">
        {uploadedLogo || hit?.image ? <img src={uploadedLogo ?? hit?.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : label}
      </span>
    </span>
  )
}
import { useBrandLogo } from '../lib/brandLogos'
