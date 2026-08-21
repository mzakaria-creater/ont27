import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'

const STATUS_FILTERS = ['PENDING', 'APPROVED', 'DECLINED']
const CURRENCY = 'EGP'

export interface PayoutRow {
  maven_id: number; guid: string | null; ontarget_ref: string | null; status: string; amount: number | null
  pay_by: string | null; merchant: string | null; account_name: string | null; mobile_no: string | null
  agent_name: string | null; approved_by: string | null; commission: number | null; remark: string | null
  image_url: string | null; created_utc: string | null; first_seen_at: string | null; last_seen_at: string | null
}
interface PayoutDetail extends PayoutRow { updated_utc: string | null }
interface ListResponse { rows: PayoutRow[]; total: number; limit: number; offset: number }
interface DecisionResult { ok: boolean; audit_log_id?: number; executed_on_provider: boolean; mode?: 'manual' | 'auto'; note?: string; after_status?: string | null; provider_raw_status_was?: string | null }
interface ExecSettings { auto_execute_enabled: boolean; max_auto_amount: number | null }

export default function Payouts() {
  const [pageSize, setPageSize] = usePageSize('payouts')
  const { can } = useAuth()
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<PayoutDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionErr, setDecisionErr] = useState<string | null>(null)
  const [decisionResult, setDecisionResult] = useState<DecisionResult | null>(null)
  const [proofUrl, setProofUrl] = useState<string | null>(null)
  const [proofName, setProofName] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [remark, setRemark] = useState('')
  // Manual stays the default. Auto only appears when the switch is on, so the
  // UI never offers a button the worker is going to refuse.
  const [mode, setMode] = useState<'manual' | 'auto'>('manual')
  const [utr, setUtr] = useState('')
  const [execSettings, setExecSettings] = useState<ExecSettings | null>(null)
  const appliedQ = params.get('q') ?? ''

  useEffect(() => {
    void api<{ settings: ExecSettings }>('/api/payouts/execution-settings')
      .then((r) => setExecSettings(r.settings)).catch(() => setExecSettings(null))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const search = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
    if (status) search.set('status', status)
    if (appliedQ) search.set('q', appliedQ)
    try { setData(await api<ListResponse>(`/api/payouts?${search}`)) }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض السحوبات.', 'You do not have permission to view payouts.') : t('تعذّر تحميل السحوبات.', 'Failed to load payouts.')) }
    finally { setLoading(false) }
  }, [status, appliedQ, page, pageSize])
  useEffect(() => { void load() }, [load])

  const setFilter = (next: { status?: string; q?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    if (next.status !== undefined) { next.status ? p.set('status', next.status) : p.delete('status'); p.delete('page') }
    if (next.q !== undefined) { next.q ? p.set('q', next.q) : p.delete('q'); p.delete('page') }
    if (next.page !== undefined) { next.page > 1 ? p.set('page', String(next.page)) : p.delete('page') }
    setParams(p)
  }
  const openDetail = async (mavenId: number) => {
    setDetailLoading(true); setDecisionErr(null); setDecisionResult(null); setProofUrl(null); setProofName(null); setRemark('')
    try { setSelected((await api<{ payout: PayoutDetail }>(`/api/payouts/${mavenId}`)).payout) }
    catch { setErr(t('تعذّر تحميل تفاصيل السحب.', 'Failed to load payout details.')) } finally { setDetailLoading(false) }
  }
  const uploadProof = async (file: File | null) => {
    if (!file) return
    setUploading(true); setDecisionErr(null)
    try {
      const form = new FormData(); form.set('file', file)
      const result = await api<{ proof_url: string }>('/api/payouts/proof', { method: 'POST', body: form })
      setProofUrl(result.proof_url); setProofName(file.name)
    } catch (e) { setDecisionErr(e instanceof ApiError ? `${t('تعذّر رفع الإثبات', 'Proof upload failed')}: ${e.code}` : t('تعذّر رفع الإثبات.', 'Proof upload failed.')) }
    finally { setUploading(false) }
  }
  const decide = async (decision: 'APPROVED' | 'DECLINED') => {
    if (!selected || (decision === 'APPROVED' && !proofUrl)) return
    setDecisionBusy(true); setDecisionErr(null); setDecisionResult(null)
    try {
      const result = await api<DecisionResult>(`/api/payouts/${selected.maven_id}/decision`, {
        method: 'POST', body: JSON.stringify({ decision, proof_url: proofUrl, remark, mode, utr_number: utr.trim() || undefined }),
      })
      setDecisionResult(result); void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') { setDecisionErr(t('حالة السحب تغيّرت بالفعل — أعد التحميل.', 'Payout status already changed — reload.')); void load() }
      else if (e instanceof ApiError && e.status === 403) setDecisionErr(t('لا تملك صلاحية الاعتماد الفعلية لهذا الدور.', 'Your role lacks approval permission.'))
      else setDecisionErr(t('فشل تسجيل القرار عبر عامل السحوبات.', 'Failed to record the decision via the payout worker.'))
    } finally { setDecisionBusy(false) }
  }
  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1

  return <PanelShell>
    <section className="page-head"><h2>📤 {t('السحوبات', 'Payouts')}</h2><p className="page-sub">{t('قرارات السحب تُسجّل عبر عامل القرارات مع سجل تدقيق وإثبات للمقبول.', 'Payout decisions are recorded via the decision worker with an audit trail and proof for approvals.')}{data && <> · {data.total.toLocaleString('en-US')}</>}</p></section>
    <div className="filter-bar"><div className="chip-row"><button className={`chip${status === '' ? ' chip-active' : ''}`} onClick={() => setFilter({ status: '' })}>{t('الكل', 'All')}</button>{STATUS_FILTERS.map((s) => <button key={s} className={`chip${status === s ? ' chip-active' : ''}`} onClick={() => setFilter({ status: s })}>{statusMeta(s).label}</button>)}</div><form className="search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}><input className="login-input search-input" placeholder={t('بحث: مرجع / موبايل / اسم حساب / تاجر', 'Search: ref / phone / account name / merchant')} value={q} onChange={(e) => setQ(e.target.value)} /><button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>{appliedQ && <button type="button" className="btn-ghost btn-sm" onClick={() => { setQ(''); setFilter({ q: '' }) }}>{t('مسح', 'Clear')}</button>}</form></div>
    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {loading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {!loading && data?.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
      {!loading && data && data.rows.length > 0 && <div className="table-wrap"><table className="data-table clickable"><thead><tr><th>{t('رقم العملية', 'Ref')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('المستفيد', 'Beneficiary')}</th><th>{t('الطريقة', 'Method')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('الحالة', 'Status')}</th><th>{t('اعتمد بواسطة', 'Approved by')}</th><th>{t('الوقت', 'Time')}</th><th>{t('إجراء', 'Action')}</th></tr></thead><tbody>{data.rows.map((row) => { const st = statusMeta(row.status); return <tr key={row.maven_id} onClick={() => void openDetail(row.maven_id)}><td className="mono">{row.ontarget_ref ?? row.maven_id}<div className="cell-sub mono">{row.maven_id}</div></td><td className="mono">{money(row.amount, CURRENCY)}</td><td>{row.account_name ?? '—'}{row.mobile_no && <div className="cell-sub mono">{row.mobile_no}</div>}</td><td>{row.pay_by ?? '—'}</td><td>{row.merchant ?? '—'}</td><td><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></td><td>{row.status === 'PENDING' ? '—' : row.approved_by ?? '—'}</td><td className="mono">{depositTime(row)}</td><td onClick={(e) => e.stopPropagation()}><button className="btn-ghost btn-sm" onClick={() => void openDetail(row.maven_id)}>{row.status === 'PENDING' && can('payouts', 'can_approve') ? t('سجل قرار', 'Record decision') : t('👁 تفاصيل', '👁 Details')}</button></td></tr> })}</tbody></table></div>}
      {data && totalPages > 1 && <div className="pager"><button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>→ {t('السابق', 'Prev')}</button><PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setFilter({ page: 1 }) }} />
            <span className="pager-info mono">{page} / {totalPages}</span><button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>{t('التالي', 'Next')} ←</button></div>}
    </section>
    {(selected || detailLoading) && <div className="drawer-backdrop" onClick={() => !decisionBusy && setSelected(null)}><aside className="drawer" onClick={(e) => e.stopPropagation()}>{detailLoading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}{selected && <><div className="drawer-head"><h3 className="mono">{selected.ontarget_ref ?? selected.maven_id}</h3><button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button></div><div className="drawer-amount"><span className="mono">{money(selected.amount, CURRENCY)}</span><span className={`pay-status-badge ${statusMeta(selected.status).cls}`}>{statusMeta(selected.status).label}</span></div><dl className="detail-grid"><dt>{t('رقم العملية', 'Ref')}</dt><dd className="mono">{selected.maven_id}</dd><dt>{t('المستفيد', 'Beneficiary')}</dt><dd>{selected.account_name ?? '—'} {selected.mobile_no && <span className="mono">({selected.mobile_no})</span>}</dd><dt>{t('الطريقة', 'Method')}</dt><dd>{selected.pay_by ?? '—'}</dd><dt>{t('التاجر', 'Merchant')}</dt><dd>{selected.merchant ?? '—'}</dd><dt>{t('اعتمده', 'Approved by')}</dt><dd>{selected.approved_by ?? '—'}</dd></dl>{selected.image_url && <a className="pay-status-link" href={selected.image_url} target="_blank" rel="noreferrer">🧾 {t('عرض إيصال التحويل', 'View transfer receipt')}</a>}{decisionErr && <div className="card warn">{decisionErr}</div>}{decisionResult && (decisionResult.executed_on_provider ? <div className="card"><strong>{t('نُفِّذ على المزوّد وتأكّد.', 'Executed on the provider and verified.')}</strong><br />{t('حالة المزوّد بعد التنفيذ:', 'Provider status after execution:')} <span className="mono">{decisionResult.after_status ?? '—'}</span><br /><span className="mono">audit_log_id: {decisionResult.audit_log_id ?? '—'} · executed_on_provider: true</span></div> : <div className="card warn"><strong>{t('تم تسجيل القرار فقط.', 'Decision recorded only.')}</strong><br />{t('التنفيذ على بوابة المزوّد لم يتم من هنا — نفّذه بنفسك.', 'Provider execution did not happen from here — do it yourself on the portal.')}<br /><span className="mono">audit_log_id: {decisionResult.audit_log_id ?? '—'} · executed_on_provider: false</span></div>)}{selected.status === 'PENDING' && can('payouts', 'can_approve') && !decisionResult && <div className="drawer-actions"><label className="btn-ghost btn-sm" style={{ cursor: uploading ? 'wait' : 'pointer' }}>📎 {uploading ? t('جارٍ رفع الإثبات…', 'Uploading proof…') : proofName ?? t('رفع إثبات التحويل', 'Upload transfer proof')}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden disabled={uploading} onChange={(e) => void uploadProof(e.target.files?.[0] ?? null)} /></label><textarea className="login-input" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={t('ملاحظة اختيارية', 'Optional note')} /><div className="filter-pills" role="group"><button className={`pill${mode === 'manual' ? ' active' : ''}`} onClick={() => setMode('manual')}>{t('تنفيذ يدوي', 'Manual')}</button>{execSettings?.auto_execute_enabled && <button className={`pill${mode === 'auto' ? ' active' : ''}`} onClick={() => setMode('auto')}>{t('تنفيذ آلي على المزوّد', 'Auto on provider')}</button>}</div>{mode === 'auto' && <><label className="field-label">{t('رقم التحويل UTR (إلزامي)', 'Transfer reference / UTR (required)')}</label><input className="login-input" dir="ltr" value={utr} onChange={(e) => setUtr(e.target.value)} placeholder={t('رقم التحويل الفعلي', 'The real transfer reference')} /></>}<p className="drawer-note">{mode === 'auto' ? t('سيُرسل هذا فعلياً إلى بوابة المزوّد ويُحوّل المال. المزوّد يرفض بدون رقم تحويل، ويُتحقق من النتيجة من قائمته قبل تسجيل النجاح.', 'This really posts to the provider portal and moves money. The provider refuses without a transfer reference, and the result is verified against its own list before success is recorded.') : t('الموافقة تتطلب إثباتاً مرفوعاً. القرار يُسجَّل فقط — نفّذ التحويل على بوابة المزوّد بنفسك.', 'Approval requires an uploaded proof. The decision is only recorded — move the money on the provider portal yourself.')}</p>{!execSettings?.auto_execute_enabled && <p className="cell-sub">{t('التنفيذ الآلي مُطفأ حالياً.', 'Automatic execution is currently switched off.')}</p>}<button className="btn-primary" disabled={decisionBusy || uploading || !proofUrl || (mode === 'auto' && !utr.trim())} onClick={() => void decide('APPROVED')}>{mode === 'auto' ? t('نفّذ على المزوّد', 'Execute on provider') : t('تسجيل مقبول', 'Record approved')}</button><button className="btn-ghost danger" disabled={decisionBusy || uploading} onClick={() => void decide('DECLINED')}>{t('تسجيل مرفوض', 'Record declined')}</button></div>}{selected.status === 'PENDING' && !can('payouts', 'can_approve') && <p className="drawer-note">{t('لا تملك صلاحية', 'You lack')} <span className="mono">can_approve</span> {t('الفعلية على صفحة السحوبات.', 'on the payouts page.')}</p>}</>}</aside></div>}
  </PanelShell>
}
