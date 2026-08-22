import { RefreshCcw, UserRoundPlus } from 'lucide-react'
import { useLocale } from '../lib/locale'
import type { DepositRow } from '../lib/deposits'

export default function DepositKindBadge({ row }: { row: DepositRow }) {
  const { t } = useLocale()
  const retention = row.deposit_kind === 'retention'
  const Icon = retention ? RefreshCcw : UserRoundPlus
  const label = retention ? t('إيداع متكرر', 'Retention deposit') : t('أول إيداع', 'First deposit')
  const detail = retention
    ? t(`لديه ${row.approved_deposits_before ?? 0} إيداع معتمد سابقاً`, `${row.approved_deposits_before ?? 0} previously approved deposit(s)`)
    : t('لا يوجد إيداع معتمد سابقاً لهذا الرقم', 'No previously approved deposit for this number')

  return (
    <span className={`deposit-kind ${retention ? 'is-retention' : 'is-first'}`} title={detail} aria-label={`${label}: ${detail}`}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}
