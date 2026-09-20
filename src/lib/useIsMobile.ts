import { useEffect, useState } from 'react'

// Matches the breakpoint most of the app's own @media rules already use
// (detail-modal-backdrop, reports-page-head, etc.) — one shared source of
// truth for "is this a phone" instead of each page picking its own number.
const QUERY = '(max-width: 720px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
