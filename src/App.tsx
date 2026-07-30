import { useAuth } from './auth/AuthContext'
import LoginPage from './auth/LoginPage'
import Dashboard from './Dashboard'

export default function App() {
  const { status } = useAuth()

  if (status === 'loading') {
    return (
      <div className="shell">
        <main className="main">
          <div className="card">
            <p>جارٍ التحقق من الجلسة…</p>
          </div>
        </main>
      </div>
    )
  }

  return status === 'signed_in' ? <Dashboard /> : <LoginPage />
}
