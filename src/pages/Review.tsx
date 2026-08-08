import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import ProofModal from '../components/ProofModal'
import { api, ApiError } from '../lib/api'
import { depositTime } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Row { kind: 'deposit' | 'payout'; id: number; ref: string | null; provider_id: number | null; decision: string | null; actor_name: string | null; note: string | null; proof_url: string | null; db_status_before: string | null; executed_on_provider: boolean | null; created_at: string | null }

export default function Review() {
  const { t } = useLocale()
  const [data, setData] = useState<{ rows: Row[]; pendingProvider: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'pending' | 'deposit' | 'payout'>('all')
  const [proof, setProof] = useState<{ url: string; ref: string } | null>(null)
  const load = useCallback(async () => {
    try {
      setData(await api(`/api/review${filter === 'pending' ? '?pending_provider=1' : ''}`))
      setErr(null)
    } catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية شاشة المراجعة.', 'You do not have review permission.') : t('تعذر التحميل.', 'Unable to load.')) }
  }, [filter, t])
  useEffect(() => { void load(); const id = setInterval(() => void load(), 30_000); return () => clearInterval(id) }, [load])
  const rows = (data?.rows ?? []).filter((r) => filter === 'all' || filter === 'pending' || r.kind === filter)
  return <PanelShell>
    <section className="page-head"><h2>{t('مراجعة القرارات', 'Decision review')}</h2><p className="page-sub">{t('سجل قرارات الإيداع والسحب اليدوية من الجدولين، مع إبراز ما لم يُنفَّذ فعلياً على المزوّد بعد.', 'Manual deposit & payout decisions from both logs, highlighting anything not yet executed on the provider.')}</p></section>
    {data !== null && data.pendingProvider > 0 && <div className="card warn">⚠️ {t(`${data.pendingProvider} قرار مسجَّل لكنه لم يُنفَّذ على بوابة المزوّد بعد — التنفيذ الفعلي يدوي.`, `${data.pendingProvider} decision(s) recorded but not yet executed on the provider portal — execution is manual.`)}</div>}
    <div className="filter-bar">
      {([['all', t('الكل', 'All')], ['pending', t('بانتظار التنفيذ على المزوّد', 'Awaiting provider execution')], ['deposit', t('إيداعات', 'Deposits')], ['payout', t('سحوبات', 'Payouts')]] as const).map(([key, label]) =>
        <button key={key} className={`pill${filter === key ? ' active' : ''}`} onClick={() => setFilter(key)}>{label}</button>)}
    </div>
    {err && <div className="card warn">{err}</div>}
    {!data && !err && <p className="sidebar-hint">{t('جار التحميل…', 'Loading…')}</p>}
    {data && <section className="card recent-card"><div className="table-wrap"><table className="data-table">
      <thead><tr><th>{t('النوع', 'Kind')}</th><th>{t('المرجع', 'Ref')}</th><th>{t('القرار', 'Decision')}</th><th>{t('الحالة قبل', 'Status before')}</th><th>{t('بواسطة', 'By')}</th><th>{t('التنفيذ على المزوّد', 'Provider execution')}</th><th>{t('إثبات', 'Proof')}</th><th>{t('ملاحظة', 'Note')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
      <tbody>{rows.length ? rows.map((r) => <tr key={`${r.kind}-${r.id}`}>
        <td>{r.kind === 'deposit' ? t('إيداع', 'Deposit') : t('سحب', 'Payout')}</td>
        <td className="mono">{r.kind === 'deposit' && r.ref ? <Link to={`/transactions/${r.ref}`}>{r.ref}</Link> : (r.ref ?? r.provider_id ?? '—')}</td>
        <td><span className={`pay-status-badge ${r.decision === 'PAID' || r.decision === 'APPROVED' ? 'st-paid' : r.decision === 'DECLINED' ? 'st-declined' : 'st-dim'}`}>{r.decision ?? '—'}</span></td>
        <td className="mono">{r.db_status_before ?? '—'}</td>
        <td>{r.actor_name ?? '—'}</td>
        <td>{r.executed_on_provider ? <span className="pay-status-badge st-paid">{t('منفَّذ', 'Executed')}</span> : <span className="pay-status-badge st-pending">{t('يدوي — لم يُنفَّذ', 'Manual — not executed')}</span>}</td>
        <td>{r.proof_url ? <button className="btn-ghost btn-sm" onClick={() => setProof({ url: r.proof_url!, ref: r.ref ?? String(r.provider_id ?? '') })} aria-label={t('عرض إثبات الدفع', 'View payment proof')}>📷 {t('عرض', 'View')}</button> : '—'}</td>
        <td>{r.note ?? '—'}</td>
        <td className="mono">{r.created_at ? depositTime({ first_seen_at: r.created_at }) : '—'}</td>
      </tr>) : <tr><td colSpan={9} className="sidebar-hint">{t('لا توجد قرارات مسجلة.', 'No recorded decisions.')}</td></tr>}</tbody>
    </table></div></section>}
    {proof && <ProofModal url={proof.url} title={`${t('إثبات الدفع', 'Payment proof')} · ${proof.ref}`} onClose={() => setProof(null)} />}
  </PanelShell>
}
