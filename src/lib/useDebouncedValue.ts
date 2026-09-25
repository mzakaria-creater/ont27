import { useEffect, useState } from 'react'

// Mirrors `value` after it stops changing for `delayMs`, so a search box can
// trigger a fetch automatically without a request per keystroke.
export function useDebouncedValue<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
