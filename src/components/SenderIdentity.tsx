import { Link } from 'react-router-dom'
import MethodLogo from './MethodLogo'

const networkFromPhone = (phone: string | null | undefined) => {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const local = digits.startsWith('20') ? `0${digits.slice(2)}` : digits
  if (local.startsWith('010')) return 'Vodafone Cash'
  if (local.startsWith('012')) return 'Orange Money'
  if (local.startsWith('011')) return 'Etisalat Cash'
  if (local.startsWith('015')) return 'WE Pay'
  return null
}

export default function SenderIdentity({ name, phone, unknown = '—', nameHref, phoneHref }: {
  name: string | null | undefined
  phone: string | null | undefined
  unknown?: string
  nameHref?: string
  phoneHref?: string
}) {
  const network = networkFromPhone(phone)
  const label = name ?? unknown
  return <span className="sender-identity">
    {network && <MethodLogo method={network} />}
    <span>
      {nameHref ? <Link className="transaction-cell-link sender-identity-name" to={nameHref}>{label}</Link> : <strong className="sender-identity-name">{label}</strong>}
      {phoneHref && phone ? <Link className="cell-sub mono transaction-cell-link" to={phoneHref}>{phone}</Link> : <span className="mono">{phone ?? '—'}</span>}
    </span>
  </span>
}
