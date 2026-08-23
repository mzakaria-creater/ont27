import { useBrandLogo } from '../lib/brandLogos'

const MELBET_LOGO = 'https://play-lh.googleusercontent.com/sY10bJqcHlRijOZXjIyWcejedc27K4v2WgzmuUphLVkVf4lBN_1_CQXON3CoIMC96ZQvUBI-1GCz5eHUxOUGUQ'

export default function MerchantLogo({ merchant }: { merchant: string | null | undefined }) {
  const raw = (merchant ?? '').trim()
  const isMelBet = /mel\s*bet/i.test(raw)
  const uploadedLogo = useBrandLogo('merchant', raw)
  const logo = uploadedLogo ?? (isMelBet ? MELBET_LOGO : null)

  return (
    <span className={`merchant-brand-cell${isMelBet ? ' merchant-brand-melbet' : ''}`}>
      {logo ? (
        <img className="merchant-brand-logo" src={logo} alt={raw} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className="merchant-brand-fallback" aria-hidden="true">{raw ? raw.slice(0, 1).toUpperCase() : '—'}</span>
      )}
      <span className="merchant-brand-name">{raw || '—'}</span>
    </span>
  )
}
