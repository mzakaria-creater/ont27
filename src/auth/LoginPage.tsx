import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth, loginErrorMessage } from './AuthContext'
import { useLocale } from '../lib/locale'

export default function LoginPage() {
  const { login } = useAuth()
  const { locale, toggleLocale, t } = useLocale()
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
        <div className="recent-head">
          <h1 className="login-title">OnTarget Panel</h1>
          <button type="button" className="btn-ghost btn-sm" onClick={toggleLocale}>{locale === 'ar' ? 'EN' : 'AR'}</button>
        </div>
        <p className="login-sub">{t('تسجيل الدخول للوحة التحكم', 'Sign in to the control panel')}</p>

        <div className="login-field">
          <label className="login-label" htmlFor="username">{t('اسم المستخدم', 'Username')}</label>
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
          <label className="login-label" htmlFor="password">{t('كلمة المرور', 'Password')}</label>
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
          {busy ? t('جارٍ التحقق…', 'Checking…') : t('دخول ←', 'Sign in →')}
        </button>

        {error && (
          <div className="login-err" role="alert">{error}</div>
        )}

        <div className="login-footnote">
          <span className="login-soon-link" title={t('غير متاح بعد', 'Not available yet')}>{t('نسيت كلمة المرور؟', 'Forgot password?')}</span>
        </div>
      </form>
    </div>
  )
}