import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import PaymentCheckout from './pages/PaymentCheckout'
import PaymentStatus from './pages/PaymentStatus'
import LinkGenerator from './pages/LinkGenerator'

function Topbar() {
  const { user, logout, status, can } = useAuth()
  if (status !== 'authed') return null
  return (
    <header className="topbar">
      <img src="/logo.svg" alt="OnTarget" className="logo" />
      <h1>OnTarget <span className="brand-sub">Payment Provider</span></h1>
      <nav className="topnav">
        <Link to="/">الرئيسية</Link>
        {can('checkout-builder') && <Link to="/merchant-link-generator">روابط الدفع</Link>}
      </nav>
      <div className="spacer" />
      <span className="conn">
        {user?.display_name} · <span className="mono">{user?.role}</span>
      </span>
      <button className="btn-ghost" onClick={() => void logout()}>خروج</button>
    </header>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="shell">
          <Topbar />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/payment-checkout" element={<PaymentCheckout />} />
            <Route path="/payment-status" element={<PaymentStatus />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/merchant-link-generator" element={<LinkGenerator />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </BrowserRouter>
    </AuthProvider>
  )
}
