let inFlight: Promise<boolean> | null = null

// One shared browser-side pump for provider → old DB → panel DB. Multiple
// mounted screens reuse the same request instead of creating a sync storm.
export function syncProviders(): Promise<boolean> {
  inFlight ??= fetch('/api/cron/delta-sync', { method: 'POST', credentials: 'same-origin' })
    .then(async (response) => {
      const body = await response.json().catch(() => null) as { ok?: boolean } | null
      const ok = response.ok && body?.ok === true
      if (ok) window.dispatchEvent(new CustomEvent('ontarget:provider-sync'))
      return ok
    })
    .catch(() => false)
    .finally(() => { inFlight = null })
  return inFlight
}
