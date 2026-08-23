import { Image } from 'lucide-react'
import { useLocale } from '../lib/locale'

export default function ProofIconButton({ url, onOpen, compact = false }: { url: string; onOpen: (url: string) => void; compact?: boolean }) {
  const { t } = useLocale()
  const label = t('عرض إثبات الدفع', 'View payment proof')
  return <button type="button" className={`proof-icon-button${compact ? ' is-compact' : ''}`} title={label} aria-label={label}
    onClick={(event) => { event.stopPropagation(); onOpen(url) }}>
    <Image size={compact ? 16 : 18} aria-hidden="true" />
    {!compact && <span>{label}</span>}
  </button>
}
