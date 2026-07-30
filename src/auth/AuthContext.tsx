import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as authApi from '../lib/authApi'
import type { AuthUser, PagePermission } from '../lib/authApi'

interface AuthState {
  status: 'loading' | 'signed_out' | 'signed_in'
  user: AuthUser | null
  permissions: PagePermission[]
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<authApi.LoginResult>
  logout: () => Promise<void>
  can: (pageKey: string, action: keyof Omit<PagePermission, 'page_key'>) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    permissions: [],
  })

  const loadSession = useCallback(async () => {
    const session = await authApi.me()
    if (session) {
      setState({ status: 'signed_in', user: session.user, permissions: session.permissions })
      return true
    }
    return false
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      // Access cookie may have expired between page loads — one silent refresh
      // attempt before giving up and showing the login screen.
      const ok = (await loadSession()) || ((await authApi.refresh()) && (await loadSession()))
      if (alive && !ok) setState({ status: 'signed_out', user: null, permissions: [] })
    })()
    return () => {
      alive = false
    }
  }, [loadSession])

  // Proactively refresh the access token a little before it expires (access
  // TTL is 20 minutes server-side) so an active user never gets bounced.
  useEffect(() => {
    if (state.status !== 'signed_in') return
    const iv = setInterval(
      async () => {
        const ok = await authApi.refresh()
        if (!ok) setState({ status: 'signed_out', user: null, permissions: [] })
      },
      15 * 60 * 1000,
    )
    return () => clearInterval(iv)
  }, [state.status])

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await authApi.login(username, password)
      if (result.step === 'authenticated') {
        setState({ status: 'signed_in', user: result.user, permissions: [] })
        void loadSession()
      }
      return result
    },
    [loadSession],
  )

  const logout = useCallback(async () => {
    await authApi.logout()
    setState({ status: 'signed_out', user: null, permissions: [] })
  }, [])

  const can = useCallback(
    (pageKey: string, action: keyof Omit<PagePermission, 'page_key'>) => {
      const p = state.permissions.find((x) => x.page_key === pageKey)
      return Boolean(p?.[action])
    },
    [state.permissions],
  )

  const value = useMemo(
    () => ({ ...state, login, logout, can }),
    [state, login, logout, can],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
