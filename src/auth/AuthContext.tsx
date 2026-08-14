import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import type { MeResponse, PagePermission, PanelUser } from '../lib/api'

type AuthStatus = 'loading' | 'authed' | 'anon'

interface AuthState {
  status: AuthStatus
  user: PanelUser | null
  permissions: PagePermission[]
  twofaEnrolled: boolean
  login: (username: string, password: string, remember?: boolean) => Promise<void>
  logout: () => Promise<void>
  refreshPermissions: () => Promise<void>
  can: (pageKey: string, action?: keyof Omit<PagePermission, 'page_key'>) => boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [me, setMe] = useState<MeResponse | null>(null)

  const loadMe = useCallback(async () => {
    try {
      const data = await api<MeResponse>('/api/auth/me')
      setMe(data)
      setStatus('authed')
    } catch {
      setMe(null)
      setStatus('anon')
    }
  }, [])

  useEffect(() => { void loadMe() }, [loadMe])

  // Proactively refresh a little before the 15-min access TTL so an active
  // user never gets bounced mid-action (lib/api still silently retries on 401).
  useEffect(() => {
    if (status !== 'authed') return
    const iv = setInterval(() => {
      void fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    }, 12 * 60 * 1000)
    return () => clearInterval(iv)
  }, [status])

  const login = useCallback(async (username: string, password: string, remember = true) => {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, remember }),
    })
    await loadMe()
  }, [loadMe])

  const logout = useCallback(async () => {
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* cookies cleared anyway */ }
    setMe(null)
    setStatus('anon')
  }, [])

  const value = useMemo<AuthState>(() => ({
    status,
    user: me?.user ?? null,
    permissions: me?.permissions ?? [],
    twofaEnrolled: me?.twofa_enrolled ?? false,
    login,
    logout,
    refreshPermissions: loadMe,
    can: (pageKey, action = 'can_view') => {
      const row = me?.permissions.find((p) => p.page_key === pageKey)
      return !!row?.[action]
    },
  }), [status, me, login, logout, loadMe])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside <AuthProvider>')
  return ctx
}

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials') return 'اسم المستخدم أو كلمة المرور غير صحيحة'
    if (err.code === 'locked' || err.code === 'account_locked') {
      const until = err.body?.until ? new Date(err.body.until as string) : null
      const time = until ? until.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : ''
      return `الحساب مقفول مؤقتاً بعد محاولات فاشلة متكررة${time ? ` — حاول بعد ${time}` : ''}`
    }
    if (err.code === 'missing_credentials') return 'أدخل اسم المستخدم وكلمة المرور'
  }
  return 'تعذر الاتصال بالخادم — حاول مرة أخرى'
}
