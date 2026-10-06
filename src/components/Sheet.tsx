import { type CSSProperties, type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

// A reusable slide-in panel. Every page that needed this (SmsLive, Deposits,
// Merchants, Complaints, UserEditor, TransactionEditDialog/Panel) hand-
// duplicated the same .drawer-backdrop/.drawer/.drawer-head/.drawer-actions
// JSX scaffold — this wraps that exact, already-proven CSS instead of
// inventing a parallel one, so existing pages look identical if/when they
// switch to it. side="start" (the default) is pixel-identical to what every
// one of those pages already renders; "end"/"top"/"bottom" are additive.

interface SheetProps {
  open: boolean
  onClose: () => void
  side?: 'start' | 'end' | 'top' | 'bottom'
  ariaLabel?: string
  // Disables both Escape-to-close and backdrop-click-to-close — e.g. while a
  // decision/save is in flight and closing mid-request would be wrong.
  busy?: boolean
  children: ReactNode
}

export function Sheet({ open, onClose, side = 'start', ariaLabel, busy = false, children }: SheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null
  const sideClass = side === 'start' ? '' : ` sheet-side-${side}`
  return (
    <div className={`drawer-backdrop${sideClass}`} onClick={() => !busy && onClose()}>
      <aside className={`drawer sheet-panel${sideClass}`} onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </aside>
    </div>
  )
}

export function SheetHeader({ title, subtitle, onClose, busy = false, children }: { title: ReactNode; subtitle?: ReactNode; onClose?: () => void; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="drawer-head">
      <div>
        <h3>{title}</h3>
        {subtitle && <p className="cell-sub">{subtitle}</p>}
      </div>
      {children}
      {onClose && <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy} aria-label="Close">✕</button>}
    </div>
  )
}

export function SheetDescription({ children }: { children: ReactNode }) {
  return <p className="drawer-note">{children}</p>
}

export function SheetFooter({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="drawer-actions" style={style}>{children}</div>
}

// Exported for parity with the ported component's API and for a consumer
// that wants an explicit close button anywhere in its own content, not just
// in SheetHeader.
export function SheetClose({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  return <button type="button" className="btn-ghost btn-sm" onClick={onClose}>{children ?? <X size={15}/>}</button>
}
