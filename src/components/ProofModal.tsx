import { useEffect } from 'react'
import { useLocale } from '../lib/locale'

// Lightbox for payment-proof images. Opens over the page instead of a new tab
// so operators stay in context while reviewing evidence.
export default function ProofModal({ url, title, onClose }: { url: string; title?: string; onClose: () => void }) {
  const { t } = useLocale()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="proof-overlay" role="dialog" aria-modal="true" aria-label={title ?? t('إثبات الدفع', 'Payment proof')} onClick={onClose}>
      <div className="proof-modal" onClick={(e) => e.stopPropagation()}>
        <div className="proof-head">
          <strong>{title ?? t('إثبات الدفع', 'Payment proof')}</strong>
          <div className="proof-actions">
            <a className="btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">{t('فتح في تبويب', 'Open in tab')}</a>
            <button className="btn-ghost btn-sm" onClick={onClose} aria-label={t('إغلاق', 'Close')}>✕</button>
          </div>
        </div>
        <div className="proof-body">
          <img src={url} alt={title ?? t('إثبات الدفع', 'Payment proof')} />
        </div>
      </div>
    </div>
  )
}
