import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Notifications center — the bell's data, expanded.

export interface NotifData {
  pendingDeposits: number
  pendingPayouts: number
  smsReview: number
  offlineDevices: string[]
  latestPending: { tx_id: number; ontarget_ref: string | null; amount: number | null; currency: string | null; sender_name: string | null; merchant: string | null; master_merchant?: string | null }[]
  latestPayouts?: { maven_id: number; ontarget_ref: string | null; amount: number | null; account_name: string | null; mobile_no: string | null; merchant: string | null }[]
  recentMatches?: { id: number; received_at: string | null; device_name: string | null; sender_name: string | null; amount: number | null; trx_id: string | null; matched_transaction_id: number | null }[]
  total: number
}

export default function Notifications() {
  const { t } = useLocale()
  const [data, setData] = useState<NotifData | null>(null)

  useEffect(() => {
    const load = () => void api<NotifData>('/api/notifications').then(setData).catch(() => {})
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🔔 {t('الإشعارات', 'Notifications')}</h2>
        <p className="page-sub">{t('كل ما يحتاج انتباهك الآن · تحديث تلقائي كل 30 ثانية', 'Everything that needs your attention now · auto-refresh every 30s')}</p>
      </section>

      {!data && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {data && (
        <>
          <div className="kpi-grid">
            <Link to="/deposits?status=PENDING" className="kpi-card amber">
              <span className="kpi-icon">💰</span>
              <div className="kpi-value">{data.pendingDeposits}</div>
              <div className="kpi-label">{t('إيداعات معلّقة', 'Pending deposits')}</div>
            </Link>
            <Link to="/payouts?status=PENDING" className="kpi-card amber">
              <span className="kpi-icon">📤</span>
              <div className="kpi-value">{data.pendingPayouts}</div>
              <div className="kpi-label">{t('سحوبات معلّقة', 'Pending payouts')}</div>
            </Link>
            <Link to="/sms?match=review" className="kpi-card">
              <span className="kpi-icon">📨</span>
              <div className="kpi-value">{data.smsReview}</div>
              <div className="kpi-label">{t('رسائل تحتاج مراجعة (48 ساعة)', 'SMS needing review (48h)')}</div>
            </Link>
            <Link to="/wallets" className="kpi-card">
              <span className="kpi-icon">📵</span>
              <div className="kpi-value">{data.offlineDevices.length}</div>
              <div className="kpi-label">{t('أجهزة غير متصلة', 'Offline devices')}{data.offlineDevices.length > 0 && `: ${data.offlineDevices.join('، ')}`}</div>
            </Link>
          </div>

          <section className="card recent-card">
            <div className="recent-head">
              <h3>{t('أحدث الإيداعات المعلّقة', 'Latest pending deposits')}</h3>
              <Link to="/approvals" className="pay-status-link">{t('فتح طابور الموافقات ←', 'Open approval queue →')}</Link>
            </div>
            {data.latestPending.length === 0 && <p>{t('لا يوجد شيء معلّق 🎉', 'Nothing pending 🎉')}</p>}
            {data.latestPending.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>{t('رقم العملية', 'Ref')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('المُرسِل', 'Sender')}</th><th>{t('التاجر', 'Merchant')}</th></tr></thead>
                  <tbody>
                    {data.latestPending.map((r) => (
                      <tr key={r.tx_id}>
                        <td className="mono">{r.ontarget_ref ?? r.tx_id}</td>
                        <td className="mono">{money(r.amount, r.currency)}</td>
                        <td>{r.sender_name ?? '—'}</td>
                        <td>{r.merchant ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </PanelShell>
  )
}
