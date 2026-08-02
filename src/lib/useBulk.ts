import { useState } from 'react'

// Bulk approve/decline over the existing per-row decision endpoints —
// sequential so every decision gets its own audit_log row.
export function useBulk(decisionPath: (id: number) => string, onDone: () => void) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (ids: number[]) => {
    setSelected((prev) => (prev.size >= ids.length && ids.every((i) => prev.has(i)) ? new Set() : new Set(ids)))
  }

  const run = async (action: 'approve' | 'decline') => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    let ok = 0
    let fail = 0
    const ids = [...selected]
    for (const id of ids) {
      setProgress(`${action === 'approve' ? 'اعتماد' : 'رفض'} ${ok + fail + 1} / ${ids.length}…`)
      try {
        const res = await fetch(decisionPath(id), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        if (res.ok) ok += 1
        else fail += 1
      } catch {
        fail += 1
      }
    }
    setProgress(`تم: ${ok} نجحت${fail ? ` · ${fail} فشلت` : ''}`)
    setSelected(new Set())
    setBusy(false)
    onDone()
    setTimeout(() => setProgress(null), 4000)
  }

  return { selected, busy, progress, toggle, toggleAll, run, clear: () => setSelected(new Set()) }
}
