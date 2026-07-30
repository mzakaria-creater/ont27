// Thin client for the /api/auth/* serverless functions. All calls use
// credentials:'include' so the httpOnly session cookies travel with the
// request; no token is ever held in JS memory or localStorage.

export interface AuthUser {
  id: string
  username: string
  role: string
  display_name?: string | null
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

async function callApi<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = (await res.json().catch(() => ({}))) as T
  return { status: res.status, data }
}

export type LoginResult =
  | { step: 'authenticated'; user: AuthUser }
  | { step: 'account_locked'; locked_until?: string }
  | { step: 'invalid' }
  | { step: 'server_error' }

export async function login(username: string, password: string): Promise<LoginResult> {
  const { status, data } = await callApi<{
    step?: string
    user?: AuthUser
    locked_until?: string
    error?: string
  }>('/api/auth/login', { username, password })

  if (status === 200 && data.step === 'authenticated' && data.user) {
    return { step: 'authenticated', user: data.user }
  }
  if (status === 423) {
    return { step: 'account_locked', locked_until: data.locked_until }
  }
  if (status === 500) return { step: 'server_error' }
  return { step: 'invalid' }
}

export async function logout(): Promise<void> {
  await callApi('/api/auth/logout')
}

export async function refresh(): Promise<boolean> {
  const { status } = await callApi('/api/auth/refresh')
  return status === 200
}

export async function me(): Promise<{
  user: AuthUser
  permissions: PagePermission[]
} | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  if (!res.ok) return null
  return (await res.json()) as { user: AuthUser; permissions: PagePermission[] }
}
