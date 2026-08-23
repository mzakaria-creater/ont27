import { useEffect, useState } from 'react'
import { api } from './api'

let logos: Record<string, string> | null = null
let loading: Promise<Record<string, string>> | null = null
const listeners = new Set<() => void>()

function load() {
  loading ??= api<{ logos: Record<string, string> }>('/api/branding')
    .then((result) => { logos = result.logos; listeners.forEach((fn) => fn()); return result.logos })
    .catch(() => { logos = {}; return {} })
  return loading
}

export function refreshBrandLogos() { loading = null; logos = null; return load() }

export function useBrandLogo(type: 'merchant' | 'user' | 'method', key: string | null | undefined) {
  const [, render] = useState(0)
  useEffect(() => {
    const rerender = () => render((n) => n + 1)
    listeners.add(rerender); void load()
    return () => { listeners.delete(rerender) }
  }, [])
  return key ? logos?.[`${type}:${key.trim().toLowerCase()}`] ?? null : null
}
