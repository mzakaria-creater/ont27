import { useEffect, useRef, useState } from 'react'
import { Columns3 } from 'lucide-react'

export interface ColumnDef { id: string; label: string }

// Column visibility persists per table (storageKey) in localStorage. Falls
// back to `defaults` the first time, or if a saved id no longer exists (a
// column was renamed/removed since).
export function useVisibleColumns(storageKey: string, allIds: string[], defaults: string[]): [Set<string>, (ids: string[]) => void] {
  const [visible, setVisible] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const saved = JSON.parse(raw) as string[]
        const filtered = saved.filter((id) => allIds.includes(id))
        if (filtered.length) return new Set(filtered)
      }
    } catch { /* ignore malformed/unavailable storage */ }
    return new Set(defaults)
  })
  const update = (ids: string[]) => {
    setVisible(new Set(ids))
    try { localStorage.setItem(storageKey, JSON.stringify(ids)) } catch { /* ignore */ }
  }
  return [visible, update]
}

export default function ColumnPicker({ columns, visible, onChange, label }: {
  columns: ColumnDef[]
  visible: Set<string>
  onChange: (ids: string[]) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const closeEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeEscape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', closeEscape) }
  }, [open])

  const toggle = (id: string) => {
    const next = new Set(visible)
    if (next.has(id)) next.delete(id); else next.add(id)
    onChange([...next])
  }

  return (
    <div className="column-picker" ref={ref}>
      <button type="button" className={`btn-ghost btn-sm${open ? ' active' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="true">
        <Columns3 size={14} /> {label} <span className="column-picker-count">{visible.size}/{columns.length}</span>
      </button>
      {open && (
        <div className="column-picker-menu" role="menu">
          {columns.map((c) => (
            <label key={c.id} className="column-picker-option">
              <input type="checkbox" checked={visible.has(c.id)} onChange={() => toggle(c.id)} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
