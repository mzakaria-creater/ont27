import { useBrandLogo } from '../lib/brandLogos'

export default function UserLogo({ username, name }: { username: string | null | undefined; name?: string | null }) {
  const key = username?.trim() ?? ''
  const logo = useBrandLogo('user', key)
  const label = (name ?? key).trim()
  return <span className="user-brand-cell">{logo ? <img src={logo} alt="" loading="lazy" /> : <span aria-hidden="true">{label.slice(0, 1).toUpperCase() || '—'}</span>}<span>{label || '—'}</span></span>
}
