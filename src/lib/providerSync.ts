let inFlight: Promise<boolean> | null = null
let lastStartedAt = 0
const CLIENT_COOLDOWN_MS = 10_000
const SHARED_KEY = 'ontarget-provider-sync-started-at'

// One shared browser-side pump for provider → old DB → panel DB. Multiple
// mounted screens reuse the same request instead of creating a sync storm.
export function syncProviders(): Promise<boolean> {
  const now = Date.now()
  let sharedStartedAt = 0
  try { sharedStartedAt = Number(localStorage.getItem(SHARED_KEY) ?? 0) } catch { /* storage may be unavailable */ }
  if (!inFlight && now - Math.max(lastStartedAt, sharedStartedAt) < CLIENT_COOLDOWN_MS) return Promise.resolve(true)
  if (document.visibilityState === 'hidden') return Promise.resolve(true)
  lastStartedAt = now
  try { localStorage.setItem(SHARED_KEY, String(now)) } catch { /* best-effort cross-tab coordination */ }
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
