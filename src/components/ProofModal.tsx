import { useEffect, useState } from 'react'
import { useLocale } from '../lib/locale'
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'

// Lightbox for payment-proof images. Opens over the page instead of a new tab
// so operators stay in context while reviewing evidence.
export default function ProofModal({ url, title, onClose }: { url: string; title?: string; onClose: () => void }) {
  const { t } = useLocale()
  const [zoom, setZoom] = useState(1)
  const changeZoom = (next: number) => setZoom(Math.min(3, Math.max(.5, Math.round(next * 10) / 10)))
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
            <button className="btn-ghost btn-sm" disabled={zoom <= .5} onClick={() => changeZoom(zoom - .2)} aria-label={t('تصغير', 'Zoom out')} title={t('تصغير', 'Zoom out')}><ZoomOut size={16} /></button>
            <span className="proof-zoom-value mono" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button className="btn-ghost btn-sm" disabled={zoom >= 3} onClick={() => changeZoom(zoom + .2)} aria-label={t('تكبير', 'Zoom in')} title={t('تكبير', 'Zoom in')}><ZoomIn size={16} /></button>
            <button className="btn-ghost btn-sm" disabled={zoom === 1} onClick={() => setZoom(1)} aria-label={t('إعادة الحجم', 'Reset zoom')} title={t('إعادة الحجم', 'Reset zoom')}><RotateCcw size={15} /></button>
            <a className="btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">{t('فتح في تبويب', 'Open in tab')}</a>
            <button className="btn-ghost btn-sm" onClick={onClose} aria-label={t('إغلاق', 'Close')}>✕</button>
          </div>
        </div>
        <div className="proof-body" onWheel={(event) => { if (event.deltaY < 0) changeZoom(zoom + .1); else changeZoom(zoom - .1) }}>
          <img src={url} alt={title ?? t('إثبات الدفع', 'Payment proof')} style={{ transform: `scale(${zoom})` }} onDoubleClick={() => changeZoom(zoom >= 2 ? 1 : zoom + .5)} />
        </div>
      </div>
    </div>
  )
}
