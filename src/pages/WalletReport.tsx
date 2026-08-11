import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Wallet SMS report — per-wallet reconciliation (idea adapted from the old
// wallet-sms-report, rebuilt in the panel's own design). Each receiving wallet
// with its SMS volume, deposits, withdrawals, unconfirmed count, and balance.

interface WalletRow {
  wallet: string; device: string | null; merchant: string | null
  sms_count: number; sms_amount: number | null
  deposits_count: number; deposits_amount: number | null
  withdrawals_count: number; withdrawals_amount: number | null
  unconfirmed: number; balance: number | null; first_balance: number | null; last_sms: string | null
}

// Balance diff = (balance change) − (deposits − withdrawals). Mirrors the old
// report's "Balance extra": SMS-reported activity vs the actual balance move.
// Large values are usually treasury sweeps out of the wallet, not errors.
function balanceDiff(r: WalletRow): number | null {
  if (r.balance == null || r.first_balance == null) return null
  return Math.round(((r.balance - r.first_balance) - ((r.deposits_amount ?? 0) - (r.withdrawals_amount ?? 0))) * 100) / 100
}

export default function WalletReport() {
  const { t } = useLocale()
  const [rows, setRows] = useState<WalletRow[] | null>(null)
  const [days, setDays] = useState(30)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRows(null)
    try { setRows((await api<{ rows: WalletRow[] }>(`/api/wallet-report?days=${days}`)).rows); setErr(null) }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض تقرير المحافظ.', 'You do not have permission to view the wallet report.') : t('تعذّر تحميل التقرير.', 'Failed to load the report.')) }
  }, [days, t])
  useEffect(() => { void load() }, [load])

  const totals = (rows ?? []).reduce((a, r) => ({
    wallets: a.wallets + 1,
    sms: a.sms + r.sms_count,
    deposits: a.deposits + (r.deposits_amount ?? 0),
    withdrawals: a.withdrawals + (r.withdrawals_amount ?? 0),
    unconfirmed: a.unconfirmed + r.unconfirmed,
    balance: a.balance + (r.balance ?? 0),
  }), { wallets: 0, sms: 0, deposits: 0, withdrawals: 0, unconfirmed: 0, balance: 0 })

  return <PanelShell>
    <section className="page-head">
      <h2>📊 {t('تقرير المحافظ (SMS)', 'Wallet SMS report')}</h2>
      <p className="page-sub">{t('كل SMS ومبلغ ورصيد وفرق لكل محفظة مستقبِلة.', 'Every SMS, amount, balance and difference per receiving wallet.')}</p>
    </section>

    <div className="kpi-grid">
      <div className="kpi-card"><div className="kpi-value">{rows ? totals.wallets : '…'}</div><div className="kpi-label">{t('المحافظ', 'Wallets')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? totals.sms.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('رسائل SMS', 'SMS received')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? money(totals.deposits, 'EGP') : '…'}</div><div className="kpi-label">{t('إيداعات', 'Deposits')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? money(totals.withdrawals, 'EGP') : '…'}</div><div className="kpi-label">{t('سحوبات', 'Withdrawals')}</div></div>
      <div className="kpi-card stat-pending"><div className="kpi-value">{rows ? totals.unconfirmed.toLocaleString('en-US') : '…'}</div><div className="kpi-label">{t('غير مؤكدة', 'Unconfirmed')}</div></div>
      <div className="kpi-card"><div className="kpi-value">{rows ? money(totals.balance, 'EGP') : '…'}</div><div className="kpi-label">{t('إجمالي الرصيد', 'Total balance')}</div></div>
    </div>

    <div className="filter-bar">
      <div className="filter-pills">
        {[7, 30, 90].map((d) => <button key={d} className={`pill${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>{t('آخر', 'Last')} {d} {t('يوم', 'days')}</button>)}
      </div>
    </div>

    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {!rows && !err && <p className="sidebar-hint">{t('جارٍ الحساب…', 'Calculating…')}</p>}
      {rows && rows.length === 0 && <p>{t('لا توجد بيانات في هذه الفترة.', 'No data in this window.')}</p>}
      {rows && rows.length > 0 && <div className="table-wrap"><table className="data-table">
        <thead><tr>
          <th>{t('المحفظة', 'Wallet')}</th><th>{t('الجهاز / التاجر', 'Device / merchant')}</th>
          <th>SMS</th><th>{t('مبلغ SMS', 'SMS amount')}</th>
          <th>{t('إيداعات', 'Deposits')}</th><th>{t('سحوبات', 'Withdrawals')}</th>
          <th>{t('غير مؤكدة', 'Unconfirmed')}</th><th>{t('الرصيد الحالي', 'Balance')}</th>
          <th title={t('فرق نشاط SMS عن تغيّر الرصيد — غالباً تحويلات للخزينة', 'SMS activity vs balance change — usually treasury sweeps')}>{t('فرق الرصيد', 'Balance diff')}</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.wallet}>
            <td className="mono">{r.wallet}</td>
            <td>{r.device ?? '—'}{r.merchant && <div className="cell-sub">{r.merchant}</div>}</td>
            <td className="mono">{r.sms_count}</td>
            <td className="mono">{money(r.sms_amount, 'EGP')}</td>
            <td className="mono">{r.deposits_count}<div className="cell-sub mono">{money(r.deposits_amount, 'EGP')}</div></td>
            <td className="mono">{r.withdrawals_count}{r.withdrawals_count > 0 && <div className="cell-sub mono">{money(r.withdrawals_amount, 'EGP')}</div>}</td>
            <td>{r.unconfirmed > 0 ? <span className="pay-status-badge st-pending">{r.unconfirmed}</span> : <span className="mono">0</span>}</td>
            <td className="mono">{money(r.balance, 'EGP')}</td>
            <td className="mono" style={balanceDiff(r) != null && balanceDiff(r) !== 0 ? { color: 'var(--status-declined)' } : undefined}>{balanceDiff(r) != null ? money(balanceDiff(r), 'EGP') : '—'}</td>
            <td><Link className="btn-ghost btn-sm" to={`/sms?q=${encodeURIComponent(r.wallet)}`}>{t('👁 الرسائل', '👁 Messages')}</Link></td>
          </tr>
        ))}</tbody>
      </table></div>}
    </section>
  </PanelShell>
}
