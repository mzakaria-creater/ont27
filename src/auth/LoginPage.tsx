import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth, loginErrorMessage } from './AuthContext'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(loginErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-box" onSubmit={onSubmit}>
        <img src="/logo.svg" alt="OnTarget" className="login-logo" />
        <h1 className="login-title">OnTarget Panel</h1>
        <p className="login-sub">تسجيل الدخول للوحة التحكم</p>

        <div className="login-field">
          <label className="login-label" htmlFor="username">اسم المستخدم</label>
          <input
            id="username"
            className="login-input"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </div>

        <div className="login-field">
          <label className="login-label" htmlFor="password">كلمة المرور</label>
          <input
            id="password"
            className="login-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>

        <button className="login-btn" type="submit" disabled={busy}>
          {busy ? 'جارٍ التحقق…' : 'دخول ←'}
        </button>

        {error && (
          <div className="login-err" role="alert">{error}</div>
        )}

        <div className="login-footnote">
          <span className="login-soon-link" title="غير متاح بعد">نسيت كلمة المرور؟</span>
        </div>
      </form>
    </div>
  )
}
