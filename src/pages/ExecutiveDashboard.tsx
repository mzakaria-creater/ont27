import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

type Period = 'day' | 'week' | 'month'
interface WindowStats { depositCount: number; depositVolume: number; payoutCount: number; payoutVolume: number; declined: number; attempts: number }
interface ExecutiveData {
  generatedAt: string
  windows: Record<Period, WindowStats>
  queues: { pendingDeposits: number; pendingPayouts: number; smsReview: number }
  devices: { total: number; online: number; rows: { device: string | null; sim_slot: number | null; online: boolean | null; battery: number | null; last_seen_at: string | null }[] }
  topMerchants: { merchant: string; volume: number; count: number }[]
  daily: { date: string; incoming: number; outgoing: number }[]
}

export default function ExecutiveDashboard() {
  const { t } = useLocale()
  const [period, setPeriod] = useState<Period>('month')
  const [data, setData] = useState<ExecutiveData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api<ExecutiveData>('/api/executive-dashboard'))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية عرض لوحة الإدارة التنفيذية.', 'You do not have permission to view the Executive Dashboard.')
        : t('تعذّر تحميل بيانات لوحة الإدارة التنفيذية.', 'Unable to load Executive Dashboard data.'))
    }
  }, [t])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(interval)
  }, [load])

  const stats = data?.windows[period]
  const approvalRate = stats?.attempts ? (stats.depositCount / stats.attempts) * 100 : 0
  const net = (stats?.depositVolume ?? 0) - (stats?.payoutVolume ?? 0)
  const attention = (data?.queues.pendingDeposits ?? 0) + (data?.queues.pendingPayouts ?? 0) + (data?.queues.smsReview ?? 0)
  const maxFlow = useMemo(() => Math.max(1, ...(data?.daily ?? []).map((row) => Math.max(row.incoming, row.outgoing))), [data])
  const periods: { id: Period; ar: string; en: string }[] = [
    { id: 'day', ar: '24 ساعة', en: '24 hours' }, { id: 'week', ar: '7 أيام', en: '7 days' }, { id: 'month', ar: '30 يوماً', en: '30 days' },
  ]

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('لوحة الإدارة التنفيذية', 'Executive Dashboard')}</h2>
        <p className="page-sub">{t('ملخص حي للسيولة، الأداء، المخاطر التشغيلية، وأهم التجار.', 'A live view of liquidity, performance, operating risks, and top merchants.')}{data && <> · {t('آخر تحديث', 'Updated')} {new Date(data.generatedAt).toLocaleTimeString()}</>}</p>
        <div className="filter-bar">
          {periods.map((item) => <button key={item.id} className={period === item.id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setPeriod(item.id)}>{t(item.ar, item.en)}</button>)}
          <button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      {error && <div className="card warn">{error}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-value">{money(stats?.depositVolume ?? 0, 'EGP')}</div><div className="kpi-label">{t('إيراد الإيداعات المعتمد', 'Approved deposit volume')}</div><div className="cell-sub">{stats?.depositCount ?? 0} {t('عملية', 'transactions')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{money(stats?.payoutVolume ?? 0, 'EGP')}</div><div className="kpi-label">{t('السحوبات المعتمدة', 'Approved payout volume')}</div><div className="cell-sub">{stats?.payoutCount ?? 0} {t('عملية', 'transactions')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{money(net, 'EGP')}</div><div className="kpi-label">{t('صافي التدفق النقدي', 'Net cash flow')}</div><div className="cell-sub">{t('الوارد ناقص الصادر', 'Incoming less outgoing')}</div></div>
        <div className="kpi-card"><div className="kpi-value">{approvalRate.toFixed(1)}%</div><div className="kpi-label">{t('نسبة القبول', 'Approval rate')}</div><div className="cell-sub">{stats?.declined ?? 0} {t('مرفوض', 'declined')}</div></div>
      </div>

      <div className="stat-grid">
        <Link className="stat-card stat-pending" to="/approvals"><span className="stat-label">{t('عناصر تحتاج قراراً', 'Items needing action')}</span><span className="stat-value">{attention}</span><span className="stat-sub">{data ? `${data.queues.pendingDeposits} ${t('إيداعات', 'deposits')} · ${data.queues.pendingPayouts} ${t('سحوبات', 'payouts')} · ${data.queues.smsReview} SMS` : ''}</span></Link>
        <Link className="stat-card" to="/wallets"><span className="stat-label">{t('صحة الأجهزة', 'Device health')}</span><span className="stat-value">{data ? `${data.devices.online}/${data.devices.total}` : '…'}</span><span className="stat-sub">{t('أجهزة متصلة', 'Devices online')}</span></Link>
        <Link className="stat-card" to="/reports"><span className="stat-label">{t('متوسط قيمة الإيداع', 'Average deposit value')}</span><span className="stat-value">{money(stats?.depositCount ? stats.depositVolume / stats.depositCount : 0, 'EGP')}</span><span className="stat-sub">{t('من العمليات المعتمدة', 'From approved transactions')}</span></Link>
        <Link className="stat-card" to="/ontarget-hub"><span className="stat-label">{t('حالة السيولة', 'Liquidity status')}</span><span className="stat-value">{net >= 0 ? t('موجب', 'Positive') : t('سالب', 'Negative')}</span><span className="stat-sub">{money(Math.abs(net), 'EGP')}</span></Link>
      </div>

      <div className="responsive-content-grid executive-content-grid">
        <section className="card recent-card">
          <div className="recent-head"><h3>{t('اتجاه التدفق النقدي', 'Cash-flow trend')}</h3><span className="cell-sub">{t('آخر 30 يوماً', 'Last 30 days')}</span></div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('التاريخ', 'Date')}</th><th>{t('وارد', 'Incoming')}</th><th>{t('صادر', 'Outgoing')}</th><th>{t('الصافي', 'Net')}</th></tr></thead>
            <tbody>{(data?.daily ?? []).slice(0, 14).map((row) => <tr key={row.date}>
              <td className="mono">{row.date}</td><td><span className="mono">{money(row.incoming, 'EGP')}</span><div style={{ height: 4, marginTop: 5, background: 'var(--line)' }}><div style={{ height: '100%', width: `${(row.incoming / maxFlow) * 100}%`, background: 'var(--accent)' }} /></div></td><td><span className="mono">{money(row.outgoing, 'EGP')}</span><div style={{ height: 4, marginTop: 5, background: 'var(--line)' }}><div style={{ height: '100%', width: `${(row.outgoing / maxFlow) * 100}%`, background: 'var(--danger)' }} /></div></td><td className="mono">{money(row.incoming - row.outgoing, 'EGP')}</td>
            </tr>)}</tbody>
          </table></div>
        </section>

        <section className="card recent-card">
          <div className="recent-head"><h3>{t('أهم التجار', 'Top merchants')}</h3><Link className="pay-status-link" to="/reports">{t('التقارير', 'Reports')} ←</Link></div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('التاجر', 'Merchant')}</th><th>{t('الحجم', 'Volume')}</th><th>{t('العمليات', 'Transactions')}</th></tr></thead>
            <tbody>{(data?.topMerchants ?? []).map((row) => <tr key={row.merchant}><td>{row.merchant}</td><td className="mono">{money(row.volume, 'EGP')}</td><td className="mono">{row.count}</td></tr>)}</tbody>
          </table></div>
        </section>
      </div>
    </PanelShell>
  )
}
