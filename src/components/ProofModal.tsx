import { Fragment, useEffect, useState } from 'react'
import { useLocale } from '../lib/locale'
import { RotateCcw, Sparkles, ZoomIn, ZoomOut } from 'lucide-react'
import { api, ApiError } from '../lib/api'

// Lightbox for payment-proof images. Opens over the page instead of a new tab
// so operators stay in context while reviewing evidence.
type ProofModalProps = {
  url: string
  title?: string
  onClose: () => void
  onApprove?: () => void | Promise<void>
  onDecline?: () => void | Promise<void>
  actionBusy?: boolean
}

const EXTRACT_FIELDS: [string, [string, string]][] = [
  ['type', ['النوع', 'Type']],
  ['amount', ['المبلغ', 'Amount']],
  ['currency', ['العملة', 'Currency']],
  ['provider', ['المزود', 'Provider']],
  ['sender_name', ['اسم المُرسِل', 'Sender name']],
  ['sender_phone', ['رقم المُرسِل', 'Sender phone']],
  ['receiver_phone', ['رقم المُستقبِل', 'Receiver phone']],
  ['trx_id', ['رقم المعاملة', 'Trx ID']],
  ['date', ['التاريخ', 'Date']],
  ['time', ['الوقت', 'Time']],
  ['balance_after', ['الرصيد بعد', 'Balance after']],
]

export default function ProofModal({ url, title, onClose, onApprove, onDecline, actionBusy = false }: ProofModalProps) {
  const { t } = useLocale()
  const [zoom, setZoom] = useState(1)
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState<Record<string, unknown> | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)
  const changeZoom = (next: number) => setZoom(Math.min(3, Math.max(.5, Math.round(next * 10) / 10)))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const runExtract = async () => {
    setExtracting(true); setExtractError(null)
    try {
      const res = await api<{ extracted: Record<string, unknown> }>('/api/proof/extract', { method: 'POST', body: JSON.stringify({ url }) })
      setExtracted(res.extracted)
    } catch (e) {
      setExtractError(e instanceof ApiError && e.code === 'ai_not_configured'
        ? t('استخراج الذكاء الاصطناعي غير مُفعّل على الخادم.', 'AI extraction is not configured on the server.')
        : t('تعذّر استخراج البيانات من الصورة.', 'Could not extract data from the image.'))
    } finally {
      setExtracting(false)
    }
  }

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
            <button className="btn-ghost btn-sm" disabled={extracting} onClick={() => void runExtract()}><Sparkles size={15}/> {extracting ? t('جارٍ الاستخراج…', 'Extracting…') : t('استخراج بالذكاء', 'Extract with AI')}</button>
            <button className="btn-ghost btn-sm" onClick={onClose} aria-label={t('إغلاق', 'Close')}>✕</button>
          </div>
        </div>
        <div className="proof-body" onWheel={(event) => { if (event.deltaY < 0) changeZoom(zoom + .1); else changeZoom(zoom - .1) }}>
          <img src={url} alt={title ?? t('إثبات الدفع', 'Payment proof')} style={{ transform: `scale(${zoom})` }} onDoubleClick={() => changeZoom(zoom >= 2 ? 1 : zoom + .5)} />
        </div>
        {(extracting || extracted || extractError) && <div className="proof-extract-panel">
          <strong>{t('البيانات المستخرجة', 'Extracted data')}</strong>
          {extracting && <p className="cell-sub">{t('جارٍ تحليل الصورة بالذكاء الاصطناعي…', 'Analyzing the image with AI…')}</p>}
          {extractError && <p className="cell-sub danger-text">{extractError}</p>}
          {extracted && !extracting && (
            <dl className="detail-grid">
              {EXTRACT_FIELDS.filter(([key]) => extracted[key] != null && extracted[key] !== '').map(([key, [ar, en]]) => (
                <Fragment key={key}>
                  <dt>{t(ar, en)}</dt>
                  <dd className="mono">{String(extracted[key])}</dd>
                </Fragment>
              ))}
              {EXTRACT_FIELDS.every(([key]) => extracted[key] == null || extracted[key] === '') && <dd>{t('لم يُعثر على بيانات مالية واضحة في الصورة.', 'No clear payment data found in the image.')}</dd>}
            </dl>
          )}
        </div>}
        {(onApprove || onDecline) && <div className="proof-decision-actions">
          {onApprove && <button type="button" className="btn-primary" disabled={actionBusy} onClick={() => void onApprove()}>✅ {actionBusy ? t('جارٍ التنفيذ…', 'Processing…') : t('اعتماد', 'Approve')}</button>}
          {onDecline && <button type="button" className="btn-ghost danger" disabled={actionBusy} onClick={() => void onDecline()}>❌ {actionBusy ? t('جارٍ التنفيذ…', 'Processing…') : t('رفض', 'Decline')}</button>}
        </div>}
      </div>
    </div>
  )
}
