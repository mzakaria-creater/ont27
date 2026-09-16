import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

// Shared large centered modal shell for "open a full record without leaving
// the list" flows (transaction detail, payout detail). Traps focus-visible
// concerns to Escape-to-close + backdrop click; the caller owns everything
// inside .detail-modal-body.
export default function DetailModal({ title, subtitle, badge, onClose, busy = false, children, headerExtra }: {
  title: ReactNode
  subtitle?: ReactNode
  badge?: ReactNode
  onClose: () => void
  busy?: boolean
  children: ReactNode
  headerExtra?: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  return (
    <div className="detail-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div ref={dialogRef} className="detail-modal" role="dialog" aria-modal="true">
        <header className="detail-modal-head">
          <div className="detail-modal-head-text">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="detail-modal-head-actions">
            {badge}
            {headerExtra}
            <button type="button" className="detail-modal-close" onClick={onClose} disabled={busy} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="detail-modal-body">{children}</div>
      </div>
    </div>
  )
}
