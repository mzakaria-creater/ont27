import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Channel {
  id: string
  channel_type: string | null
  country_code: string | null
  currency_code: string | null
  display_name: string | null
  active: boolean | null
}
interface MethodStats { key: string; attempts: number; approved: number; volume: number }
interface Data {
  channels: Channel[]
  methods: MethodStats[]
  walletCount: Record<string, number>
  since: string
}

export default function PaymentMethods() {
  const { t } = useLocale()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api<Data>('/api/payment-methods'))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية عرض طرق الدفع.', 'You do not have permission to view payment methods.')
        : t('تعذّر تحميل طرق الدفع.', 'Unable to load payment methods.'))
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  const toggle = async (channel: Channel) => {
    setSaving(channel.id)
    setError(null)
    try {
      const result = await api<{ channel: Channel }>(`/api/payment-methods/${channel.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !channel.active }),
      })
      setData((current) => current ? {
        ...current,
        channels: current.channels.map((item) => item.id === result.channel.id ? result.channel : item),
      } : current)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية تعديل طرق الدفع.', 'You do not have permission to edit payment methods.')
        : t('تعذّر تحديث طريقة الدفع.', 'Unable to update the payment method.'))
    } finally {
      setSaving(null)
    }
  }

  const totals = useMemo(() => ({
    active: data?.channels.filter((channel) => channel.active).length ?? 0,
    volume: data?.methods.reduce((sum, method) => sum + method.volume, 0) ?? 0,
    attempts: data?.methods.reduce((sum, method) => sum + method.attempts, 0) ?? 0,
    approved: data?.methods.reduce((sum, method) => sum + method.approved, 0) ?? 0,
  }), [data])
  const approvalRate = totals.attempts ? (totals.approved / totals.attempts) * 100 : 0

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('💳 طرق الدفع', '💳 Payment Methods')}</h2>
        <p className="page-sub">{t('إعداد القنوات وصحتها مع نشاط حي لآخر 30 يوماً.', 'Channel configuration and health with live performance for the last 30 days.')}</p>
      </section>

      {error && <div className="card warn">{error}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-icon">✅</span><div className="kpi-value">{totals.active}</div><div className="kpi-label">{t('قنوات نشطة', 'Active channels')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">📈</span><div className="kpi-value">{approvalRate.toFixed(1)}%</div><div className="kpi-label">{t('نسبة قبول 30 يوماً', '30-day approval rate')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">💰</span><div className="kpi-value">{money(totals.volume, 'EGP')}</div><div className="kpi-label">{t('حجم معتمد 30 يوماً', '30-day approved volume')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">🔄</span><div className="kpi-value">{totals.attempts.toLocaleString('en-US')}</div><div className="kpi-label">{t('محاولات معالجة', 'Processing attempts')}</div></div>
      </div>

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('إعداد القنوات', 'Channel configuration')}</h3></div>
        {!data && !error && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {data && <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('القناة', 'Channel')}</th><th>{t('النوع', 'Type')}</th><th>{t('الدولة', 'Country')}</th><th>{t('العملة', 'Currency')}</th><th>{t('المحافظ', 'Wallets')}</th><th>{t('الحالة', 'Status')}</th><th>{t('إجراء', 'Action')}</th></tr></thead>
          <tbody>{data.channels.map((channel) => {
            const wallets = channel.display_name ? (data.walletCount[channel.display_name] ?? data.walletCount[channel.channel_type ?? ''] ?? 0) : 0
            return <tr key={channel.id}>
              <td>{channel.display_name ?? '—'}</td><td className="mono">{channel.channel_type ?? '—'}</td><td>{channel.country_code ?? '—'}</td><td className="mono">{channel.currency_code ?? '—'}</td><td className="mono">{wallets}</td>
              <td><span className={`pay-status-badge ${channel.active ? 'st-paid' : 'st-dim'}`}>{channel.active ? t('نشطة', 'Active') : t('موقوفة', 'Disabled')}</span></td>
              <td><button className={channel.active ? 'btn-ghost danger btn-sm' : 'btn-primary btn-sm'} disabled={saving === channel.id} onClick={() => void toggle(channel)}>{saving === channel.id ? t('جارٍ الحفظ…', 'Saving…') : channel.active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button></td>
            </tr>
          })}</tbody>
        </table></div>}
      </section>

      {data && <section className="card recent-card">
        <div className="recent-head"><h3>{t('أداء طرق الدفع', 'Payment method performance')}</h3><span className="cell-sub">{t('آخر 30 يوماً', 'Last 30 days')}</span></div>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{t('الطريقة', 'Method')}</th><th>{t('المحاولات', 'Attempts')}</th><th>{t('المعتمدة', 'Approved')}</th><th>{t('نسبة القبول', 'Approval rate')}</th><th>{t('الحجم المعتمد', 'Approved volume')}</th></tr></thead>
          <tbody>{data.methods.map((method) => <tr key={method.key}><td>{method.key}</td><td className="mono">{method.attempts}</td><td className="mono">{method.approved}</td><td className="mono">{method.attempts ? `${((method.approved / method.attempts) * 100).toFixed(1)}%` : '—'}</td><td className="mono">{money(method.volume, 'EGP')}</td></tr>)}</tbody>
        </table></div>
      </section>}
    </PanelShell>
  )
}
