import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Recipient {
  key: string
  recipient: string
  accountName: string | null
  count: number
  approvedCount: number
  total: number
  lastAt: string | null
  methods: string[]
  merchants: string[]
}
interface RecipientEvent {
  maven_id: number | string | null
  ontarget_ref: string | null
  amount: number | null
  status: string | null
  pay_by: string | null
  merchant: string | null
  account_name: string | null
  mobile_no: string | null
  approved_by: string | null
  first_seen_at: string | null
}
interface RecipientData { recipients: Recipient[] }
interface DetailData { events: RecipientEvent[] }

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString() : '—'
const isApproved = (status: string | null) => status === 'APPROVED' || status === 'PAID'

export default function KnownRecipients() {
  const { t } = useLocale()
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [selected, setSelected] = useState<Recipient | null>(null)
  const [events, setEvents] = useState<RecipientEvent[]>([])
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      const data = await api<RecipientData>(`/api/known-recipients${params.size ? `?${params}` : ''}`)
      setRecipients(data.recipients)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? t('لا تملك صلاحية عرض المستلمين.', 'You do not have permission to view recipients.')
        : t('تعذّر تحميل بيانات المستلمين.', 'Unable to load recipient data.'))
    } finally {
      setLoading(false)
    }
  }, [from, q, t, to])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [load])

  const choose = async (recipient: Recipient) => {
    setSelected(recipient)
    setDetailLoading(true)
    try {
      const data = await api<DetailData>(`/api/known-recipients/${encodeURIComponent(recipient.key)}`)
      setEvents(data.events)
    } catch {
      setEvents([])
      setError(t('تعذّر تحميل سجل المستلم.', 'Unable to load recipient history.'))
    } finally {
      setDetailLoading(false)
    }
  }

  const totals = useMemo(() => ({
    volume: recipients.reduce((sum, row) => sum + row.total, 0),
    events: recipients.reduce((sum, row) => sum + row.count, 0),
    approved: recipients.reduce((sum, row) => sum + row.approvedCount, 0),
  }), [recipients])
  const approvalRate = totals.events ? (totals.approved / totals.events) * 100 : 0

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('🎯 المستلمون المعروفون', '🎯 Known Recipients')}</h2>
        <p className="page-sub">{t('دليل حي للمستلمين من سجل السحوبات، مع الإجماليات وسجل التحويلات.', 'A live payout-recipient directory with totals and transfer history.')}</p>
      </section>

      {error && <div className="card warn">{error}</div>}

      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-icon">👥</span><div className="kpi-value">{recipients.length.toLocaleString('en-US')}</div><div className="kpi-label">{t('مستلمون', 'Recipients')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">📤</span><div className="kpi-value">{totals.events.toLocaleString('en-US')}</div><div className="kpi-label">{t('عمليات سحب', 'Outgoing events')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">💰</span><div className="kpi-value">{money(totals.volume, 'EGP')}</div><div className="kpi-label">{t('إجمالي مدفوع معتمد', 'Approved paid total')}</div></div>
        <div className="kpi-card"><span className="kpi-icon">✅</span><div className="kpi-value">{approvalRate.toFixed(1)}%</div><div className="kpi-label">{t('نسبة الاعتماد', 'Approval rate')}</div></div>
      </div>

      <section className="card recent-card">
        <div className="filter-bar">
          <input value={q} onChange={(event) => setQ(event.target.value)} placeholder={t('ابحث بالرقم أو الاسم أو التاجر…', 'Search number, name, or merchant…')} />
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label={t('من', 'From')} />
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label={t('إلى', 'To')} />
          <button className="btn-ghost btn-sm" onClick={() => { setQ(''); setFrom(''); setTo('') }}>{t('كل الوقت', 'All time')}</button>
          <button className="btn-ghost btn-sm" onClick={() => void load()}>{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      <div className="responsive-content-grid recipients-content-grid">
        <section className="card recent-card">
          <div className="recent-head"><h3>{t('دليل المستلمين', 'Recipient directory')}</h3><span className="cell-sub">{loading ? t('جارٍ التحميل…', 'Loading…') : recipients.length}</span></div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('المستلم', 'Recipient')}</th><th>{t('الإجمالي', 'Total')}</th><th>{t('العمليات', 'Events')}</th></tr></thead>
            <tbody>
              {!loading && recipients.length === 0 && <tr><td colSpan={3}>{t('لا توجد نتائج.', 'No recipients found.')}</td></tr>}
              {recipients.map((row) => <tr key={row.key} onClick={() => void choose(row)} style={{ cursor: 'pointer', background: selected?.key === row.key ? 'var(--bg-muted)' : undefined }}>
                <td><strong>{row.recipient}</strong>{row.accountName && row.accountName !== row.recipient && <div className="cell-sub">{row.accountName}</div>}<div className="cell-sub">{row.methods.join(' · ') || '—'}</div></td>
                <td className="mono">{money(row.total, 'EGP')}</td>
                <td><span className="mono">{row.count}</span><div className="cell-sub">{formatTime(row.lastAt)}</div></td>
              </tr>)}
            </tbody>
          </table></div>
        </section>

        <section className="card recent-card">
          <div className="recent-head">
            <div><h3>{selected ? selected.recipient : t('سجل المستلم', 'Recipient history')}</h3>{selected?.accountName && <span className="cell-sub">{selected.accountName}</span>}</div>
            {selected && <span className="cell-sub">{selected.merchants.join(' · ') || '—'}</span>}
          </div>
          {!selected && <p className="sidebar-hint">{t('اختر مستلماً من القائمة لعرض كل التحويلات.', 'Select a recipient to view every transfer.')}</p>}
          {selected && detailLoading && <p className="sidebar-hint">{t('جارٍ تحميل السجل…', 'Loading history…')}</p>}
          {selected && !detailLoading && <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('المرجع', 'Reference')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('اعتمد بواسطة', 'Approved by')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
            <tbody>{events.length === 0 ? <tr><td colSpan={7}>{t('لا توجد عمليات.', 'No transfers found.')}</td></tr> : events.map((row) => <tr key={String(row.maven_id ?? row.ontarget_ref)}>
              <td className="mono">{row.ontarget_ref ?? row.maven_id ?? '—'}</td><td className="mono">{money(row.amount, 'EGP')}</td><td>{row.pay_by ?? '—'}</td><td>{row.merchant ?? '—'}</td><td>{row.approved_by ?? '—'}</td><td><span className={`pay-status-badge ${isApproved(row.status) ? 'st-paid' : 'st-dim'}`}>{row.status ?? '—'}</span></td><td className="mono">{formatTime(row.first_seen_at)}</td>
            </tr>)}</tbody>
          </table></div>}
        </section>
      </div>
    </PanelShell>
  )
}
