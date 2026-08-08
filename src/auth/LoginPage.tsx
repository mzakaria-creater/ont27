import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth, loginErrorMessage } from './AuthContext'
import { useLocale } from '../lib/locale'

function Check() {
  return (
    <svg className="auth-check" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <path d="M6 10.4l2.6 2.6L14 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

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

  const features: [string, string][] = [
    [t('مراقبة لحظية للإيداعات والسحوبات', 'Live deposit & payout monitoring')],
    [t('كل قرار موثّق في سجل تدقيق', 'Every decision recorded in an audit log')],
    [t('صلاحيات حقيقية لكل دور وصفحة', 'Real per-role, per-page permissions')],
  ].map((x) => [x[0], x[0]]) as [string, string][]

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <aside className="auth-hero" aria-hidden="true">
          <div className="auth-hero-top">
            <img src="/logo.svg" alt="" className="auth-hero-logo" />
            <span className="auth-brand">OnTarget</span>
          </div>
          <div className="auth-hero-body">
            <h2 className="auth-hero-title">{t('لوحة تحكم المدفوعات', 'Payments Control Panel')}</h2>
            <p className="auth-hero-sub">{t('إدارة العمليات المالية لحظيًا بأمان وشفافية كاملة.', 'Run financial operations in real time — secure and fully transparent.')}</p>
            <ul className="auth-features">
              {features.map(([label], i) => (
                <li key={i}><Check /><span>{label}</span></li>
              ))}
            </ul>
          </div>
          <div className="auth-hero-foot">
            <span className="auth-status"><span className="auth-dot" />{t('بيئة الإنتاج', 'Production environment')}</span>
          </div>
        </aside>

        <form className="auth-form" onSubmit={onSubmit}>
          <div className="auth-form-head">
            <img src="/logo.svg" alt="OnTarget" className="auth-form-logo" />
            <button type="button" className="btn-ghost btn-sm" onClick={toggleLocale} aria-label={locale === 'ar' ? 'Switch to English' : 'التبديل للعربية'}>{locale === 'ar' ? 'EN' : 'ع'}</button>
          </div>
          <h1 className="auth-title">{t('تسجيل الدخول', 'Sign in')}</h1>
          <p className="auth-sub">{t('ادخل ببيانات حسابك للمتابعة.', 'Enter your account credentials to continue.')}</p>

          <div className="login-field">
            <label className="login-label" htmlFor="username">{t('اسم المستخدم', 'Username')}</label>
            <input id="username" className="login-input" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} autoFocus />
          </div>

          <div className="login-field">
            <label className="login-label" htmlFor="password">{t('كلمة المرور', 'Password')}</label>
            <input id="password" className="login-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </div>

          <button className="login-btn" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? t('جارٍ التحقق…', 'Checking…') : t('دخول', 'Sign in')}
          </button>

          {error && <div className="login-err" role="alert">{error}</div>}

          <div className="login-footnote">
            <span className="login-soon-link" title={t('غير متاح بعد', 'Not available yet')}>{t('نسيت كلمة المرور؟', 'Forgot password?')}</span>
          </div>
        </form>
      </div>
    </div>
  )
}
