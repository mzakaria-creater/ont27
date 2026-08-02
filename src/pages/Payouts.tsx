import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'

const PAGE_SIZE = 25
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
interface DecisionResult { ok: boolean; audit_log_id?: number; executed_on_provider: boolean; note?: string; provider_raw_status_was?: string | null }

export default function Payouts() {
  const { can } = useAuth()
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
  const appliedQ = params.get('q') ?? ''

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (status) search.set('status', status)
    if (appliedQ) search.set('q', appliedQ)
    try { setData(await api<ListResponse>(`/api/payouts?${search}`)) }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض السحوبات.' : 'تعذّر تحميل السحوبات.') }
    finally { setLoading(false) }
  }, [status, appliedQ, page])
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
    catch { setErr('تعذّر تحميل تفاصيل السحب.') } finally { setDetailLoading(false) }
  }
  const uploadProof = async (file: File | null) => {
    if (!file) return
    setUploading(true); setDecisionErr(null)
    try {
      const form = new FormData(); form.set('file', file)
      const result = await api<{ proof_url: string }>('/api/payouts/proof', { method: 'POST', body: form })
      setProofUrl(result.proof_url); setProofName(file.name)
    } catch (e) { setDecisionErr(e instanceof ApiError ? `تعذّر رفع الإثبات: ${e.code}` : 'تعذّر رفع الإثبات.') }
    finally { setUploading(false) }
  }
  const decide = async (decision: 'APPROVED' | 'DECLINED') => {
    if (!selected || (decision === 'APPROVED' && !proofUrl)) return
    setDecisionBusy(true); setDecisionErr(null); setDecisionResult(null)
    try {
      const result = await api<DecisionResult>(`/api/payouts/${selected.maven_id}/decision`, {
        method: 'POST', body: JSON.stringify({ decision, proof_url: proofUrl, remark }),
      })
      setDecisionResult(result); void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') { setDecisionErr('حالة السحب تغيّرت بالفعل — أعد التحميل.'); void load() }
      else if (e instanceof ApiError && e.status === 403) setDecisionErr('لا تملك صلاحية الاعتماد الفعلية لهذا الدور.')
      else setDecisionErr('فشل تسجيل القرار عبر عامل السحوبات.')
    } finally { setDecisionBusy(false) }
  }
  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1

  return <PanelShell>
    <section className="page-head"><h2>📤 السحوبات</h2><p className="page-sub">قرارات السحب تُسجّل عبر عامل القرارات مع سجل تدقيق وإثبات للمقبول.{data && <> · {data.total.toLocaleString('en-US')} نتيجة</>}</p></section>
    <div className="filter-bar"><div className="chip-row"><button className={`chip${status === '' ? ' chip-active' : ''}`} onClick={() => setFilter({ status: '' })}>الكل</button>{STATUS_FILTERS.map((s) => <button key={s} className={`chip${status === s ? ' chip-active' : ''}`} onClick={() => setFilter({ status: s })}>{statusMeta(s).label}</button>)}</div><form className="search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}><input className="login-input search-input" placeholder="بحث: مرجع / موبايل / اسم حساب / تاجر" value={q} onChange={(e) => setQ(e.target.value)} /><button type="submit" className="btn-primary btn-sm">بحث</button>{appliedQ && <button type="button" className="btn-ghost btn-sm" onClick={() => { setQ(''); setFilter({ q: '' }) }}>مسح</button>}</form></div>
    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {loading && <p className="sidebar-hint">جارٍ التحميل…</p>}
      {!loading && data?.rows.length === 0 && <p>لا توجد نتائج مطابقة.</p>}
      {!loading && data && data.rows.length > 0 && <div className="table-wrap"><table className="data-table clickable"><thead><tr><th>رقم العملية</th><th>المبلغ</th><th>المستفيد</th><th>الطريقة</th><th>التاجر</th><th>الحالة</th><th>اعتمد بواسطة</th><th>الوقت</th><th>إجراء</th></tr></thead><tbody>{data.rows.map((row) => { const st = statusMeta(row.status); return <tr key={row.maven_id} onClick={() => void openDetail(row.maven_id)}><td className="mono">{row.ontarget_ref ?? row.maven_id}<div className="cell-sub mono">{row.maven_id}</div></td><td className="mono">{money(row.amount, CURRENCY)}</td><td>{row.account_name ?? '—'}{row.mobile_no && <div className="cell-sub mono">{row.mobile_no}</div>}</td><td>{row.pay_by ?? '—'}</td><td>{row.merchant ?? '—'}</td><td><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></td><td>{row.status === 'PENDING' ? '—' : row.approved_by ?? '—'}</td><td className="mono">{depositTime(row)}</td><td onClick={(e) => e.stopPropagation()}><button className="btn-ghost btn-sm" onClick={() => void openDetail(row.maven_id)}>{row.status === 'PENDING' && can('payouts', 'can_approve') ? 'سجل قرار' : '👁 تفاصيل'}</button></td></tr> })}</tbody></table></div>}
      {data && totalPages > 1 && <div className="pager"><button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>→ السابق</button><span className="pager-info mono">{page} / {totalPages}</span><button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>التالي ←</button></div>}
    </section>
    {(selected || detailLoading) && <div className="drawer-backdrop" onClick={() => !decisionBusy && setSelected(null)}><aside className="drawer" onClick={(e) => e.stopPropagation()}>{detailLoading && <p className="sidebar-hint">جارٍ التحميل…</p>}{selected && <><div className="drawer-head"><h3 className="mono">{selected.ontarget_ref ?? selected.maven_id}</h3><button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button></div><div className="drawer-amount"><span className="mono">{money(selected.amount, CURRENCY)}</span><span className={`pay-status-badge ${statusMeta(selected.status).cls}`}>{statusMeta(selected.status).label}</span></div><dl className="detail-grid"><dt>رقم العملية</dt><dd className="mono">{selected.maven_id}</dd><dt>المستفيد</dt><dd>{selected.account_name ?? '—'} {selected.mobile_no && <span className="mono">({selected.mobile_no})</span>}</dd><dt>الطريقة</dt><dd>{selected.pay_by ?? '—'}</dd><dt>التاجر</dt><dd>{selected.merchant ?? '—'}</dd><dt>اعتمده</dt><dd>{selected.approved_by ?? '—'}</dd></dl>{selected.image_url && <a className="pay-status-link" href={selected.image_url} target="_blank" rel="noreferrer">🧾 عرض إيصال التحويل</a>}{decisionErr && <div className="card warn">{decisionErr}</div>}{decisionResult && <div className="card warn"><strong>تم تسجيل القرار فقط.</strong><br />التنفيذ الفعلي على بوابة المزود يدوي ولم يتم تنفيذه آلياً.<br /><span className="mono">audit_log_id: {decisionResult.audit_log_id ?? '—'} · executed_on_provider: false</span></div>}{selected.status === 'PENDING' && can('payouts', 'can_approve') && !decisionResult && <div className="drawer-actions"><label className="btn-ghost btn-sm" style={{ cursor: uploading ? 'wait' : 'pointer' }}>📎 {uploading ? 'جارٍ رفع الإثبات…' : proofName ?? 'رفع إثبات التحويل'}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden disabled={uploading} onChange={(e) => void uploadProof(e.target.files?.[0] ?? null)} /></label><textarea className="login-input" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="ملاحظة اختيارية" /><p className="drawer-note">الموافقة تتطلب إثباتاً مرفوعاً. التنفيذ على بوابة المزود يجب أن يتم يدوياً أولاً.</p><button className="btn-primary" disabled={decisionBusy || uploading || !proofUrl} onClick={() => void decide('APPROVED')}>تسجيل مقبول</button><button className="btn-ghost danger" disabled={decisionBusy || uploading} onClick={() => void decide('DECLINED')}>تسجيل مرفوض</button></div>}{selected.status === 'PENDING' && !can('payouts', 'can_approve') && <p className="drawer-note">لا تملك صلاحية <span className="mono">can_approve</span> الفعلية على صفحة السحوبات.</p>}</>}</aside></div>}
  </PanelShell>
}
