import { useCallback, useState } from 'react'

// Shared row-count choice for the paged tables.
//
// Every table hardcoded 25. The choice is remembered per table (Deposits and
// Transactions are browsed very differently), and kept in localStorage rather
// than the URL so a shared link still opens on the recipient's own preference.
//
// 500 is the ceiling here AND in the API (server/paging.ts). The two must move
// together: a selector offering more than the endpoint will serve would show
// 100 rows while claiming 500, with nothing on screen to reveal the gap.

export const PAGE_SIZES = [20, 50, 100, 250, 500] as const

const DEFAULT = 50

export function usePageSize(tableKey: string): [number, (n: number) => void] {
  const storageKey = `ont27.pageSize.${tableKey}`

  const [size, setSize] = useState<number>(() => {
    // Storage throws outright in some embedded/private contexts, so a failure
    // to read must fall back to the default rather than break the page.
    try {
      const raw = window.localStorage.getItem(storageKey)
      const n = raw ? Number(raw) : NaN
      return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT
    } catch {
      return DEFAULT
    }
  })

  const update = useCallback((n: number) => {
    if (!(PAGE_SIZES as readonly number[]).includes(n)) return
    setSize(n)
    try { window.localStorage.setItem(storageKey, String(n)) } catch { /* not fatal */ }
  }, [storageKey])

  return [size, update]
}
