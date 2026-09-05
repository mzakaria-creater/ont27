import { Link } from 'react-router-dom'
import { money } from '../lib/deposits'

export interface QueueSms {
  id: number
  amount: number | null
  received_at: string | null
  provider: string | null
  sender_name: string | null
  sender_number: string | null
  receiver_number: string | null
  raw_sms?: string | null
  message?: string | null
  match_route?: string
  candidate_tx_id?: number | null
  candidate_count?: number
  age_hours?: number
  stale?: boolean
}

interface Props {
  waiting: QueueSms[]
  unlinked: QueueSms[]
  loading?: boolean
  error?: string | null
}

const date = (value: string | null) => value ? new Date(value).toLocaleString() : '—'

export default function SmsMatchQueues({ waiting, unlinked, loading = false, error = null }: Props) {
  if (loading) return <div className="card sms-queue-loading">جاري تجهيز قوائم ربط SMS بالمعاملات…</div>
  if (error) return <div className="card warn">تعذر تحميل قوائم انتظار SMS: {error}</div>
  if (!waiting.length && !unlinked.length) return null
  return <section className="sms-match-queues" aria-label="SMS matching queues">
    <Queue title="بانتظار معاملة" subtitle="رسائل لديها مرشح PENDING وستنتقل تلقائياً عند الربط" rows={waiting} waiting />
    <Queue title="رسائل غير مربوطة" subtitle="لا يوجد تطابق آمن بعد — ابحث واربط يدوياً عند الحاجة" rows={unlinked} />
  </section>
}

function Queue({ title, subtitle, rows, waiting = false }: { title: string; subtitle: string; rows: QueueSms[]; waiting?: boolean }) {
  if (!rows.length) return null
  return <article className={`card sms-queue ${waiting ? 'is-waiting' : 'is-unlinked'}`}>
    <header className="sms-queue-head"><div><h3>{waiting ? '⏳' : '⚠️'} {title}</h3><p>{subtitle}</p></div><strong>{rows.length}</strong></header>
    <div className="sms-queue-list">
      {rows.map((row) => <div key={row.id} className={`sms-queue-item${row.stale ? ' is-stale' : ''}`}>
        <div className="sms-queue-identity"><span className="sms-queue-label">SMS #{row.id}</span><span className="mono">{row.provider || 'Unknown provider'}</span><span className="cell-sub">{row.sender_name || row.sender_number || 'مرسل بلا اسم/رقم'} · {date(row.received_at)}</span></div>
        <div className="sms-queue-facts"><span className="mono">{money(row.amount, 'EGP')}</span><span className="mono">→ {row.receiver_number || '—'}</span>{row.candidate_tx_id ? <Link to={`/transactions/${row.candidate_tx_id}`} className="sms-queue-tx">TRX {row.candidate_tx_id}</Link> : waiting ? <span className="sms-queue-pending-tx">بانتظار TRX من Maven</span> : <Link to={`/sms?q=${row.id}`} className="sms-queue-manual">فتح للربط اليدوي</Link>}</div>
        <p className="sms-queue-raw">{row.raw_sms || row.message || 'لا يوجد نص خام'}</p>
        <div className="sms-queue-meta"><span>{row.match_route === 'phone_exact' ? 'phone_exact' : 'Orange: name + amount + balance'}</span>{row.stale && <b>متأخرة أكثر من ساعة</b>}</div>
      </div>)}
    </div>
  </article>
}
