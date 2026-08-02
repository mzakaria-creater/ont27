import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Tab = 'wallets' | 'treasury' | 'messages' | 'transactions'
interface Wallet { to_account_number: string | null; provider: string | null; device: string | null; sim_slot: number | null; payment_type: string | null; daily_limit: number | null; merchant: string | null; updated_at: string | null }
interface Device { device: string | null; sim_slot: number | null; online: boolean | null; battery: number | null; balance: number | null; last_seen_at: string | null }
interface Deposit { tx_id: number | string | null; ontarget_ref: string | null; amount: number | null; status: string | null; sender_name: string | null; sender_number: string | null; to_account_number: string | null; payment_method: string | null; approved_by: string | null; first_seen_at: string | null }
interface Payout { maven_id: number | string | null; ontarget_ref: string | null; amount: number | null; status: string | null; pay_by: string | null; merchant: string | null; account_name: string | null; mobile_no: string | null; approved_by: string | null; first_seen_at: string | null }
interface Sms { id: number; amount: number | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; device_name: string | null; sim_slot: number | null; sms_category: string | null; matched: boolean | null; received_at: string | null }
interface HubData { since: string; totals: { approvedDeposit: number; approvedPayout: number; net: number }; wallets: Wallet[]; devices: Device[]; deposits: Deposit[]; payouts: Payout[]; sms: Sms[] }

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : '—'
const approved = (status: string | null) => status === 'PAID' || status === 'APPROVED'

export default function TreasuryHub() {
  const { t } = useLocale()
  const [tab, setTab] = useState<Tab>('wallets')
  const [data, setData] = useState<HubData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api<HubData>('/api/treasury-hub'))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية عرض مركز الخزينة.', 'You do not have permission to view the treasury hub.')
        : t('تعذّر تحميل بيانات مركز الخزينة.', 'Unable to load treasury hub data.'))
    }
  }, [t])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(interval)
  }, [load])

  const deviceByKey = useMemo(() => {
    const map = new Map<string, Device>()
    for (const device of data?.devices ?? []) map.set(`${device.device ?? ''}#${device.sim_slot ?? 0}`, device)
    return map
  }, [data])

  const walletFlow = useMemo(() => {
    const map = new Map<string, { incoming: number; count: number }>()
    for (const row of data?.deposits ?? []) {
      if (!approved(row.status) || !row.to_account_number) continue
      const bucket = map.get(row.to_account_number) ?? { incoming: 0, count: 0 }
      bucket.incoming += Number(row.amount ?? 0)
      bucket.count += 1
      map.set(row.to_account_number, bucket)
    }
    return map
  }, [data])

  const transactions = useMemo(() => [
    ...(data?.deposits ?? []).map((row) => ({ type: 'deposit' as const, id: row.tx_id, ref: row.ontarget_ref, amount: row.amount, status: row.status, party: row.sender_name ?? row.sender_number, method: row.payment_method, approvedBy: row.approved_by, at: row.first_seen_at })),
    ...(data?.payouts ?? []).map((row) => ({ type: 'payout' as const, id: row.maven_id, ref: row.ontarget_ref, amount: row.amount, status: row.status, party: row.account_name ?? row.mobile_no, method: row.pay_by, approvedBy: row.approved_by, at: row.first_seen_at })),
  ].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 200), [data])

  const tabs: { id: Tab; ar: string; en: string }[] = [
    { id: 'wallets', ar: 'المحافظ', en: 'Wallets' },
    { id: 'treasury', ar: 'الخزينة', en: 'Treasury' },
    { id: 'messages', ar: 'الرسائل', en: 'Messages' },
    { id: 'transactions', ar: 'المعاملات', en: 'Transactions' },
  ]

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('🏛️ OnTarget — مركز الخزينة والمحافظ', '🏛️ OnTarget — Treasury & Wallets')}</h2>
        <p className="page-sub">{t('حركة المحافظ والرسائل والمعاملات الحية خلال آخر 30 يوماً.', 'Live wallet movement, messages, and transactions for the last 30 days.')}</p>
        <div className="filter-bar">
          <button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button>
          <Link className="btn-ghost btn-sm" to="/wallets">{t('إدارة المحافظ', 'Manage wallets')}</Link>
          <Link className="btn-ghost btn-sm" to="/sms">{t('SMS مباشر', 'Live SMS')}</Link>
          <Link className="btn-ghost btn-sm" to="/transactions">{t('كل المعاملات', 'All transactions')}</Link>
        </div>
      </section>

      {error && <div className="card warn">{error}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-icon">📥</span><div className="kpi-value">{money(data?.totals.approvedDeposit ?? 0, 'EGP')}</div><div className="kpi-label">{t('وارد معتمد · 30 يوماً', 'Approved incoming · 30 days')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">📤</span><div className="kpi-value">{money(data?.totals.approvedPayout ?? 0, 'EGP')}</div><div className="kpi-label">{t('صادر معتمد · 30 يوماً', 'Approved outgoing · 30 days')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">🏦</span><div className="kpi-value">{money(data?.totals.net ?? 0, 'EGP')}</div><div className="kpi-label">{t('صافي التدفق', 'Net flow')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">👛</span><div className="kpi-value">{data?.wallets.length ?? '…'}</div><div className="kpi-label">{t('محافظ مرتبطة', 'Mapped wallets')}</div></div>
      </div>

      <section className="card recent-card">
        <div className="filter-bar">
          {tabs.map((item) => <button key={item.id} className={tab === item.id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setTab(item.id)}>{t(item.ar, item.en)}</button>)}
        </div>
      </section>

      {tab === 'wallets' && <section className="card recent-card">
        <div className="recent-head"><h3>{t('خريطة المحافظ والأجهزة', 'Wallet & device map')}</h3><span className="cell-sub">{data ? data.wallets.length : '…'}</span></div>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('المحفظة', 'Wallet')}</th><th>{t('المزود', 'Provider')}</th><th>{t('الجهاز', 'Device')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الرصيد', 'Balance')}</th><th>{t('وارد معتمد', 'Approved incoming')}</th><th>{t('الحد اليومي', 'Daily limit')}</th></tr></thead>
          <tbody>{(data?.wallets ?? []).map((wallet, index) => {
            const device = deviceByKey.get(`${wallet.device ?? ''}#${wallet.sim_slot ?? 0}`)
            const flow = wallet.to_account_number ? walletFlow.get(wallet.to_account_number) : undefined
            return <tr key={`${wallet.to_account_number ?? index}-${wallet.device ?? ''}`}>
              <td className="mono">{wallet.to_account_number ?? '—'}<div className="cell-sub">{wallet.merchant ?? '—'}</div></td><td>{wallet.provider ?? wallet.payment_type ?? '—'}</td><td>{wallet.device ?? '—'}{wallet.sim_slot != null && <div className="cell-sub">SIM {wallet.sim_slot}</div>}</td><td><span className={`pay-status-badge ${device?.online ? 'st-paid' : 'st-dim'}`}>{device?.online ? t('متصل', 'Online') : t('غير متصل', 'Offline')}</span></td><td className="mono">{device?.balance == null ? '—' : money(device.balance, 'EGP')}</td><td className="mono">{money(flow?.incoming ?? 0, 'EGP')}<div className="cell-sub">{flow?.count ?? 0} {t('عملية', 'events')}</div></td><td className="mono">{wallet.daily_limit == null ? '—' : money(wallet.daily_limit, 'EGP')}</td>
            </tr>
          })}</tbody>
        </table></div>
      </section>}

      {tab === 'treasury' && <section className="card recent-card">
        <div className="recent-head"><h3>{t('ملخص الخزينة', 'Treasury summary')}</h3><span className="cell-sub">{t('من البيانات المعتمدة فقط', 'Approved records only')}</span></div>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('البند', 'Item')}</th><th>{t('القيمة', 'Value')}</th><th>{t('الوصف', 'Description')}</th></tr></thead>
          <tbody>
            <tr><td>{t('الإيداعات المعتمدة', 'Approved deposits')}</td><td className="mono">{money(data?.totals.approvedDeposit ?? 0, 'EGP')}</td><td>{t('تدفق وارد من آخر 30 يوماً', 'Incoming flow over the last 30 days')}</td></tr>
            <tr><td>{t('السحوبات المعتمدة', 'Approved payouts')}</td><td className="mono">{money(data?.totals.approvedPayout ?? 0, 'EGP')}</td><td>{t('تدفق صادر من آخر 30 يوماً', 'Outgoing flow over the last 30 days')}</td></tr>
            <tr><td>{t('صافي التدفق', 'Net flow')}</td><td className="mono">{money(data?.totals.net ?? 0, 'EGP')}</td><td>{t('الوارد ناقص الصادر', 'Incoming less outgoing')}</td></tr>
            <tr><td>{t('المحافظ', 'Wallets')}</td><td className="mono">{data?.wallets.length ?? 0}</td><td>{t('خريطة المحفظة والجهاز المتاحة', 'Available wallet-to-device mappings')}</td></tr>
          </tbody>
        </table></div>
      </section>}

      {tab === 'messages' && <section className="card recent-card">
        <div className="recent-head"><h3>{t('أحدث رسائل المحافظ', 'Latest wallet messages')}</h3><span className="cell-sub">{data?.sms.length ?? '…'}</span></div>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('الجهاز', 'Device')}</th><th>{t('النوع', 'Type')}</th><th>{t('المرسل', 'Sender')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('المطابقة', 'Match')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
          <tbody>{(data?.sms ?? []).map((row) => <tr key={row.id}>
            <td>{row.device_name ?? '—'}{row.sim_slot != null && <div className="cell-sub">SIM {row.sim_slot}</div>}</td><td>{row.sms_category ?? '—'}</td><td>{row.sender_name ?? row.sender_number ?? '—'}</td><td className="mono">{money(row.amount, 'EGP')}</td><td><span className={`pay-status-badge ${row.matched ? 'st-paid' : 'st-dim'}`}>{row.matched ? t('مرتبطة', 'Matched') : t('غير مرتبطة', 'Unmatched')}</span></td><td className="mono">{formatTime(row.received_at)}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}

      {tab === 'transactions' && <section className="card recent-card">
        <div className="recent-head"><h3>{t('حركة المعاملات', 'Transaction movement')}</h3><span className="cell-sub">{t('أحدث 200 عملية', 'Latest 200 records')}</span></div>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('النوع', 'Type')}</th><th>{t('المرجع', 'Reference')}</th><th>{t('الطرف', 'Party')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('اعتمد بواسطة', 'Approved by')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
          <tbody>{transactions.map((row) => <tr key={`${row.type}-${String(row.id ?? row.ref)}`}>
            <td>{row.type === 'deposit' ? t('إيداع', 'Deposit') : t('سحب', 'Payout')}</td><td className="mono">{row.ref ?? row.id ?? '—'}</td><td>{row.party ?? '—'}</td><td className="mono">{money(row.amount, 'EGP')}</td><td>{row.method ?? '—'}</td><td>{row.approvedBy ?? '—'}</td><td><span className={`pay-status-badge ${approved(row.status) ? 'st-paid' : 'st-dim'}`}>{row.status ?? '—'}</span></td><td className="mono">{formatTime(row.at)}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
    </PanelShell>
  )
}
