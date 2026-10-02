import { useCallback, useEffect, useState } from 'react'
import { Landmark, RefreshCw, TrendingDown, TrendingUp, WalletCards } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

// Internal operator dashboard — live gateway/wallet balances, pending
// deposits, and pending withdrawal requests. Backed entirely by
// server/gatewayDashboard.ts, which reads the same real tables
// (payment_accounts, maven_transactions, maven_payout_transactions) every
// other panel page already uses — nothing here is mocked or placeholder.

interface Balance {
  id: string
  account_number: string | null
  account_name: string | null
  label: string | null
  currency: string
  device: string | null
  is_active: boolean
  balance: number | null
  balance_updated_at: string | null
  device_online: boolean | null
  device_last_seen_at: string | null
}
interface PendingDeposit { tx_id: number; ref: string; amount: number; currency: string; party: string | null; merchant: string | null; method: string | null; wallet: string | null; created_at: string | null }
interface PendingWithdrawal { maven_id: number; ref: string; amount: number; method: string | null; merchant: string | null; party: string | null; wallet: string | null; created_at: string | null }
interface GatewayData {
  generated_at: string
  summary: { total_balance: number; wallet_count: number; online_devices: number; pending_deposits_count: number; pending_deposits_amount: number; pending_withdrawals_count: number; pending_withdrawals_amount: number }
  balances: Balance[]
  pending_deposits: PendingDeposit[]
  pending_withdrawals: PendingWithdrawal[]
}

export default function Gateway() {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [data, setData] = useState<GatewayData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    api<GatewayData>('/api/gateway-dashboard')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية عرض هذه الصفحة.', 'You do not have permission to view this page.')
        : t('تعذّر تحميل بيانات البوابة.', 'Failed to load gateway data.')))
      .finally(() => setLoading(false))
  }, [t])
  useEffect(() => {
    load()
    const iv = window.setInterval(load, 20_000)
    return () => window.clearInterval(iv)
  }, [load])

  return (
    <>
      <section className="page-head admin-head">
        <span className="admin-head-icon"><Landmark size={20} /></span>
        <div className="admin-head-text">
          <span className="admin-head-eyebrow">{t('المدفوعات والمحافظ', 'Payments & wallets')}</span>
          <h2>{t('البوابة والأرصدة', 'Gateway & Balances')}</h2>
          <p className="page-sub">{t('أرصدة المحافظ الحية، الإيداعات المعلّقة، وطلبات السحب المعلّقة — من الجداول الحقيقية.', 'Live wallet balances, pending deposits, and pending withdrawal requests — from the real tables.')}</p>
        </div>
        <div className="admin-head-actions"><button className="btn-ghost btn-sm" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{t('تحديث', 'Refresh')}</button></div>
      </section>

      {err && <div className="card warn">{err}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><WalletCards className="kpi-icon"/><div className="kpi-value">{data ? money(data.summary.total_balance, 'EGP') : '…'}</div><div className="kpi-label">{t('إجمالي أرصدة المحافظ', 'Total wallet balance')}</div><div className="cell-sub">{data?.summary.wallet_count ?? 0} {t('محفظة', 'wallets')} · {data?.summary.online_devices ?? 0} {t('متصلة', 'online')}</div></div>
        <div className="kpi-card"><TrendingUp className="kpi-icon positive"/><div className="kpi-value">{data?.summary.pending_deposits_count ?? 0}</div><div className="kpi-label">{t('إيداعات معلّقة', 'Pending deposits')}</div><div className="cell-sub">{data ? money(data.summary.pending_deposits_amount, 'EGP') : '—'}</div></div>
        <div className="kpi-card"><TrendingDown className="kpi-icon negative"/><div className="kpi-value">{data?.summary.pending_withdrawals_count ?? 0}</div><div className="kpi-label">{t('طلبات سحب معلّقة', 'Pending withdrawal requests')}</div><div className="cell-sub">{data ? money(data.summary.pending_withdrawals_amount, 'EGP') : '—'}</div></div>
      </div>

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('أرصدة المحافظ', 'Wallet balances')}</h3><span className="cell-sub">{t('آخر تحديث', 'Updated')} {data ? new Date(data.generated_at).toLocaleTimeString() : '—'}</span></div>
        {!data && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {data && data.balances.length === 0 && <p className="maven-empty">{t('لا توجد محافظ مسجّلة.', 'No wallets registered.')}</p>}
        {data && data.balances.length > 0 && (isMobile ? (
          <div className="risk-card-list">
            {data.balances.map((b) => (
              <div key={b.id} className="risk-row-card">
                <div className="risk-row-card-head"><span className="mono">{b.account_number ?? '—'}</span><span className="mono">{b.balance == null ? '—' : money(b.balance, b.currency)}</span></div>
                <div className="cell-sub">{b.label ?? b.account_name ?? '—'} · {b.device ?? t('بدون جهاز', 'No device')}</div>
                <div className="risk-row-card-foot">
                  <span className={`pay-status-badge ${b.is_active ? 'st-paid' : 'st-dim'}`}>{b.is_active ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span>
                  {b.device && <span className={`pay-status-badge ${b.device_online ? 'st-paid' : 'st-declined'}`}>{b.device_online ? t('متصل', 'Online') : t('غير متصل', 'Offline')}</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('المحفظة', 'Wallet')}</th><th>{t('الاسم', 'Name')}</th><th>{t('الجهاز', 'Device')}</th><th>{t('الرصيد', 'Balance')}</th><th>{t('آخر تحديث', 'Updated')}</th><th>{t('الحالة', 'Status')}</th></tr></thead>
            <tbody>
              {data.balances.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.account_number ?? '—'}</td>
                  <td>{b.label ?? b.account_name ?? '—'}</td>
                  <td>{b.device ?? '—'}{b.device && <span className={`pay-status-badge ${b.device_online ? 'st-paid' : 'st-declined'}`} style={{ marginInlineStart: 6 }}>{b.device_online ? t('متصل', 'Online') : t('غير متصل', 'Offline')}</span>}</td>
                  <td className="mono">{b.balance == null ? '—' : money(b.balance, b.currency)}</td>
                  <td className="mono">{b.balance_updated_at ? new Date(b.balance_updated_at).toLocaleString() : '—'}</td>
                  <td><span className={`pay-status-badge ${b.is_active ? 'st-paid' : 'st-dim'}`}>{b.is_active ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </section>

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('إيداعات معلّقة', 'Pending deposits')} ({data?.pending_deposits.length ?? 0})</h3></div>
        {data && data.pending_deposits.length === 0 && <p className="maven-empty">{t('لا توجد إيداعات معلّقة حالياً.', 'No pending deposits right now.')}</p>}
        {data && data.pending_deposits.length > 0 && (isMobile ? (
          <div className="risk-card-list">
            {data.pending_deposits.map((d) => (
              <div key={d.tx_id} className="risk-row-card">
                <div className="risk-row-card-head"><span className="mono">{d.ref}</span><span className="mono">{money(d.amount, d.currency)}</span></div>
                <div className="cell-sub">{d.merchant ?? '—'} · {d.party ?? '—'}</div>
                <div className="risk-row-card-foot"><span className="mono muted">{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</span></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('المرجع', 'Reference')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('الطرف', 'Party')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
            <tbody>
              {data.pending_deposits.map((d) => (
                <tr key={d.tx_id}>
                  <td className="mono">{d.ref}</td>
                  <td className="mono">{money(d.amount, d.currency)}</td>
                  <td>{d.merchant ?? '—'}</td>
                  <td>{d.party ?? '—'}</td>
                  <td>{d.method ?? '—'}</td>
                  <td className="mono">{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </section>

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('طلبات سحب معلّقة', 'Pending withdrawal requests')} ({data?.pending_withdrawals.length ?? 0})</h3></div>
        {data && data.pending_withdrawals.length === 0 && <p className="maven-empty">{t('لا توجد طلبات سحب معلّقة حالياً.', 'No pending withdrawal requests right now.')}</p>}
        {data && data.pending_withdrawals.length > 0 && (isMobile ? (
          <div className="risk-card-list">
            {data.pending_withdrawals.map((w) => (
              <div key={w.maven_id} className="risk-row-card">
                <div className="risk-row-card-head"><span className="mono">{w.ref}</span><span className="mono">{money(w.amount, 'EGP')}</span></div>
                <div className="cell-sub">{w.merchant ?? '—'} · {w.party ?? '—'}</div>
                <div className="risk-row-card-foot"><span className="mono muted">{w.created_at ? new Date(w.created_at).toLocaleString() : '—'}</span></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('المرجع', 'Reference')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('الطرف', 'Party')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
            <tbody>
              {data.pending_withdrawals.map((w) => (
                <tr key={w.maven_id}>
                  <td className="mono">{w.ref}</td>
                  <td className="mono">{money(w.amount, 'EGP')}</td>
                  <td>{w.merchant ?? '—'}</td>
                  <td>{w.party ?? '—'}</td>
                  <td>{w.method ?? '—'}</td>
                  <td className="mono">{w.created_at ? new Date(w.created_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </section>
    </>
  )
}
