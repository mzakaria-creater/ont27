// Panel API client — same-origin /api, httpOnly cookies (no tokens in JS).
// On 401, tries one silent refresh then retries the request once.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: Record<string, unknown> | null,
  ) {
    super(code)
  }
}

// A request with no backstop can hang forever if the server stalls (e.g. a
// PostgREST RPC gateway stall — the exact failure that left /api/auth/me
// unresolved and the panel stuck on "جارٍ التحقق من الجلسة…" with no way out).
// Combine with any caller-supplied signal (Transactions.tsx cancels in-flight
// list requests on filter change) rather than replacing it.
const DEFAULT_TIMEOUT_MS = 30_000

async function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal
  try {
    return await fetch(path, {
      ...init,
      signal,
      credentials: 'same-origin',
      headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers },
    })
  } catch (error) {
    // A caller-aborted request (e.g. Transactions.tsx cancelling a stale
    // list fetch) is deliberate, not a failure — let it propagate as-is so
    // callers that check for AbortError still see one.
    if (init?.signal?.aborted) throw error
    // Everything else here is "the request never got a response": DNS/TCP
    // failure, offline, CORS, or our own DEFAULT_TIMEOUT_MS firing. Wrapping
    // it in ApiError gives every caller (loginErrorMessage included) a
    // single, typed shape to check instead of an unhandled TypeError/
    // DOMException that bypassed every `instanceof ApiError` guard in the
    // app and only ever surfaced as a generic, unhelpful fallback message.
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    throw new ApiError(0, timedOut ? 'network_timeout' : 'network_error', null)
  }
}

let refreshInFlight: Promise<boolean> | null = null

export async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= rawFetch('/api/auth/refresh', { method: 'POST' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => { refreshInFlight = null })
  return refreshInFlight
}

async function tryRefresh(): Promise<boolean> { return refreshSession() }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res = await rawFetch(path, init)
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (await tryRefresh()) res = await rawFetch(path, init)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, (body?.error as string) ?? `http_${res.status}`, body)
  }
  return body as T
}

export interface PagePermission {
  page_key: string
  can_view: boolean
  can_create: boolean
  can_edit: boolean
  can_delete: boolean
  can_approve: boolean
  can_export: boolean
}

export interface PanelUser {
  id: string
  /** The login identifier. Not necessarily an email — most accounts are plain names. */
  username: string
  /** Contact address, optional and separate from the credential. */
  email?: string | null
  display_name: string
  role: string
  prefs?: Record<string, unknown>
  last_login_at?: string | null
}

export interface MeResponse {
  user: PanelUser
  permissions: PagePermission[]
  twofa_enrolled: boolean
}
