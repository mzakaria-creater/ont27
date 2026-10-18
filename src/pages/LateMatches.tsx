import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

// Bulk review of the late-SMS match proposals the automation could not decide
// on its own (SMS arrived late / after auto-decline). Each "approve" is exactly
// the same audited call the one-at-a-time popup makes (links the SMS and
// executes on the provider), just run sequentially for the rows you tick.
interface Proposal {
  id: number; tx_id: number; sms_id: number; ontarget_ref: string | null; amount: number | string | null
  sender_number: string | null; wallet: string | null; merchant: string | null
  tx_created_at: string | null; sms_received_at: string | null; delay_seconds: number | null
  sms_sender_name: string | null; match_basis: string; sms_blocked: boolean
  sms_provider?: string | null; name_conflict?: boolean
}

const fmt = (v: string | null) => v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const mins = (s: number | null) => s == null ? '—' : `${s < 0 ? '−' : '+'}${Math.round(Math.abs(s) / 60)}m`
// Safe default: sender phone + exact amount, SMS after the transaction.
const isSafe = (p: Proposal) => p.match_basis === 'identity_phone' && (p.delay_seconds ?? -1) >= 0 && !p.sms_blocked && !p.name_conflict && /vodafone/i.test(p.sms_provider ?? '')

export default function LateMatches() {
  const { t } = useLocale()
  const { can } = useAuth()
  const [rows, setRows] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [results, setResults] = useState<{ id: number; ref: string; ok: boolean; msg: string }[]>([])
  const canApprove = can('deposits', 'can_approve')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api<{ rows: Proposal[] }>('/api/late-matches?status=pending&limit=100')
      setRows(r.rows)
      setPicked(new Set(r.rows.filter(isSafe).map(p => p.id)))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const total = useMemo(() => rows.filter(r => picked.has(r.id)).reduce((a, r) => a + Number(r.amount ?? 0), 0), [rows, picked])
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const run = async (decision: 'approve' | 'reject') => {
    const todo = rows.filter(r => picked.has(r.id))
    if (!todo.length) return
    const label = decision === 'approve' ? t('الموافقة على', 'approve') : t('تجاهل', 'dismiss')
    if (!window.confirm(t(`تأكيد ${label} ${todo.length} اقتراح بإجمالي ${total.toLocaleString('en-US')} جنيه؟`, `Confirm: ${label} ${todo.length} proposal(s), total EGP ${total.toLocaleString('en-US')}?`))) return
    setResults([]); setProgress({ done: 0, total: todo.length })
    for (const [i, p] of todo.entries()) {
      try {
        await api(`/api/late-matches/${p.id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) })
        setResults(r => [...r, { id: p.id, ref: p.ontarget_ref ?? String(p.tx_id), ok: true, msg: 'OK' }])
      } catch (e) {
        setResults(r => [...r, { id: p.id, ref: p.ontarget_ref ?? String(p.tx_id), ok: false, msg: e instanceof Error ? e.message : String(e) }])
      }
      setProgress({ done: i + 1, total: todo.length })
    }
    setProgress(null)
    await load()
  }

  return <>
    <section className="page-head">
      <div className="recent-head"><h2 style={{ margin: 0 }}>🔗 {t('مطابقات الرسائل المتأخرة', 'Late SMS matches')}</h2><button className="btn-ghost btn-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={14} className={loading ? 'spin' : ''} /> {t('تحديث', 'Refresh')}</button></div>
      <p className="page-sub">{t('رسائل وصلت متأخرة وتطابق معاملات. الموافقة بتربط الرسالة وتنفّذ على المزوّد (نفس نافذة القرار الفردية).', 'Late SMS that match transactions. Approve links the SMS and executes on the provider — same action as the one-by-one popup.')}</p>
    </section>
    <section className="card recent-card">
      <div className="recent-head">
        <span>{picked.size} / {rows.length} {t('محدد', 'selected')} · <strong className="mono">{money(total, 'EGP')}</strong></span>
        <span className="chip-row">
          <button className="btn-ghost btn-sm" onClick={() => setPicked(new Set(rows.filter(isSafe).map(r => r.id)))}>{t('المطابقات الآمنة فقط', 'Safe matches only')}</button>
          <button className="btn-ghost btn-sm" onClick={() => setPicked(new Set(rows.map(r => r.id)))}>{t('الكل', 'All')}</button>
          <button className="btn-ghost btn-sm" onClick={() => setPicked(new Set())}>{t('إلغاء', 'None')}</button>
          {canApprove && <button className="btn-primary btn-sm" disabled={!picked.size || progress != null} onClick={() => void run('approve')}><Check size={14} /> {t('موافقة على المحدد', 'Approve selected')}</button>}
          {canApprove && <button className="btn-ghost btn-sm" disabled={!picked.size || progress != null} onClick={() => void run('reject')}>{t('تجاهل المحدد', 'Dismiss selected')}</button>}
        </span>
      </div>
      {progress && <p className="cell-sub">{t('جاري التنفيذ', 'Working')}… {progress.done}/{progress.total}</p>}
      <p className="cell-sub">{t('الآمن = رسالة فودافون، رقم المرسل + المبلغ مطابقين، الرسالة بعد المعاملة، والاسم غير متعارض مع تاريخ الرقم. غير الآمن (اسم CRM / مبلغ فقط / رسالة قبل المعاملة / مقفولة) غير محدد افتراضيًا — راجعه يدويًا.', 'Safe = Vodafone SMS, sender phone + exact amount match, SMS after the transaction, and no conflicting name for that phone. Others (CRM name / amount-only / SMS before the transaction / locked) are unticked by default — review them by hand.')}</p>
      <div className="table-wrap"><table className="data-table"><thead><tr><th></th><th>TRX</th><th>{t('المبلغ', 'Amount')}</th><th>{t('العميل', 'Customer')}</th><th>{t('المحفظة', 'Wallet')}</th><th>{t('وقت المعاملة', 'Tx time')}</th><th>SMS</th><th>{t('الاسم (من الرسالة)', 'Name (from SMS)')}</th><th>{t('الفرق', 'Gap')}</th><th>{t('الأساس', 'Basis')}</th></tr></thead><tbody>
        {rows.map(p => <tr key={p.id}>
          <td><input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} aria-label={`select ${p.ontarget_ref}`} /></td>
          <td><Link className="mono" to={`/transactions/${encodeURIComponent(p.ontarget_ref ?? String(p.tx_id))}`}>{p.ontarget_ref ?? p.tx_id}</Link></td>
          <td className="mono">{money(Number(p.amount ?? 0), 'EGP')}</td>
          <td className="mono">{p.sender_number ?? '—'}</td>
          <td className="mono">{p.wallet ?? '—'}</td>
          <td className="mono">{fmt(p.tx_created_at)}</td>
          <td className="mono">#{p.sms_id} · {fmt(p.sms_received_at)}<div className="cell-sub">{p.sms_provider ?? '—'}</div></td>
          <td>{p.sms_sender_name ?? '—'}{p.name_conflict && <span className="pay-status-badge st-declined" title={t('نفس الرقم ظهر قبل كده باسم مختلف', 'Same phone appeared before under a different name')}> ⚠</span>}</td>
          <td className="mono">{mins(p.delay_seconds)}</td>
          <td><span className={`pay-status-badge ${isSafe(p) ? 'st-paid' : 'st-pending'}`}>{p.match_basis === 'identity_phone' ? t('رقم + مبلغ', 'Phone + amount') : p.match_basis === 'crm_name' ? t('اسم CRM', 'CRM name') : t('مبلغ + وقت', 'Amount + time')}</span></td>
        </tr>)}
        {!loading && rows.length === 0 && <tr><td colSpan={10} className="sidebar-hint">{t('لا توجد اقتراحات معلّقة.', 'No pending proposals.')}</td></tr>}
      </tbody></table></div>
    </section>
    {results.length > 0 && <section className="card recent-card"><div className="recent-head"><h3>{t('النتيجة', 'Result')}</h3><span className="mono">{results.filter(r => r.ok).length} OK · {results.filter(r => !r.ok).length} {t('فشل', 'failed')}</span></div>
      <div className="table-wrap"><table className="data-table"><tbody>{results.map(r => <tr key={r.id}><td className="mono">{r.ref}</td><td><span className={`pay-status-badge ${r.ok ? 'st-paid' : 'st-declined'}`}>{r.ok ? 'OK' : t('فشل', 'Failed')}</span></td><td className="cell-sub">{r.ok ? '' : r.msg}</td></tr>)}</tbody></table></div></section>}
  </>
}
