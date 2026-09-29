import { api } from './api'

let inFlight: Promise<boolean> | null = null
let lastStartedAt = 0
// Keep provider changes visible within one fast-sync window while still
// sharing a single request across tabs and pages.
// Transactions and their SMS evidence are time-sensitive. Keep one shared
// request per second across all tabs/pages; an in-flight request is reused.
const CLIENT_COOLDOWN_MS = 10_000
const SHARED_KEY = 'ontarget-provider-sync-started-at'
export const PROVIDER_SYNC_PATH = '/api/cron/delta-sync'

// One shared browser-side pump for provider → old DB → panel DB. Multiple
// mounted screens reuse the same request instead of creating a sync storm.
export function syncProviders(options: { force?: boolean } = {}): Promise<boolean> {
  const now = Date.now()
  let sharedStartedAt = 0
  try { sharedStartedAt = Number(localStorage.getItem(SHARED_KEY) ?? 0) } catch { /* storage may be unavailable */ }
  // `true` means this call actually completed a provider pull. Callers use
  // that signal to do one follow-up read; cooldown/hidden skips must not cause
  // an unnecessary second API refresh.
  // Automatic pumps share the ten-second cooldown. A deliberate operator
  // refresh must bypass it; otherwise clicking Refresh immediately after an
  // automatic tick appears to do nothing even though the button completed.
  if (!options.force && !inFlight && now - Math.max(lastStartedAt, sharedStartedAt) < CLIENT_COOLDOWN_MS) return Promise.resolve(false)
  if (document.visibilityState === 'hidden') return Promise.resolve(false)
  lastStartedAt = now
  try { localStorage.setItem(SHARED_KEY, String(now)) } catch { /* best-effort cross-tab coordination */ }
  // A provider outage must not leave navigation or login stuck behind a
  // serverless request. The backend keeps its own reconciliation cron; this
  // browser pump is a low-latency hint with a hard UI deadline.
  inFlight ??= api<{ ok?: boolean }>(PROVIDER_SYNC_PATH, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  })
    .then((body) => {
      const ok = body?.ok === true
      if (ok) window.dispatchEvent(new CustomEvent('ontarget:provider-sync'))
      return ok
    })
    .catch(() => false)
    .finally(() => { inFlight = null })
  return inFlight
}
