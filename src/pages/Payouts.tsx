import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, MessageSquare } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import MerchantLogo from '../components/MerchantLogo'
import MethodLogo from '../components/MethodLogo'
import { api, ApiError } from '../lib/api'
import { money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'
import ProofModal from '../components/ProofModal'
import ProofIconButton from '../components/ProofIconButton'

const STATUS_FILTERS = ['PENDING', 'APPROVED', 'DECLINED']
const CURRENCY = 'EGP'

export interface PayoutRow {
  maven_id: number; guid: string | null; ontarget_ref: string | null; status: string; amount: number | null
  pay_by: string | null; merchant: string | null; account_name: string | null; mobile_no: string | null
  agent_name: string | null; approved_by: string | null; commission: number | null; remark: string | null
  image_url: string | null; created_utc: string | null; first_seen_at: string | null; last_seen_at: string | null
  merchant_reference: string | null; payment_type: string | null; user_account_number: string | null
  bank_name: string | null; bank_ifsc: string | null; utr_number: string | null; currency: string | null
  master_merchant: string | null; commission_percentage: number | null
  linked_sms?: { id: number; received_at: string | null; amount: number | null; receiver_number: string | null; wallet_number: string | null; provider: string | null; trx_id: string | null; trx_reference: string | null; balance_after: number | null; message: string | null } | null
}
interface PayoutDetail extends PayoutRow { updated_utc: string | null }
interface ListResponse { rows: PayoutRow[]; total: number; limit: number; offset: number }
interface DecisionResult { ok: boolean; audit_log_id?: number; executed_on_provider: boolean; mode?: 'manual' | 'auto'; note?: string; after_status?: string | null; provider_raw_status_was?: string | null }
interface ExecSettings { auto_execute_enabled: boolean; max_auto_amount: number | null }

export default function Payouts() {
  const [pageSize, setPageSize] = usePageSize('payouts')
  const { can, user } = useAuth()
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
  const [viewedProofUrl, setViewedProofUrl] = useState<string | null>(null)
  const [proofName, setProofName] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [remark, setRemark] = useState('')
  // Manual stays the default. Auto only appears when the switch is on, so the
  // UI never offers a button the worker is going to refuse.
  const [mode, setMode] = useState<'manual' | 'auto'>('manual')
  const [utr, setUtr] = useState('')
  const [execSettings, setExecSettings] = useState<ExecSettings | null>(null)
  const [maxAutoAmount, setMaxAutoAmount] = useState('')
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const appliedQ = params.get('q') ?? ''

  useEffect(() => {
    void api<{ settings: ExecSettings }>('/api/payouts/settings/execution')
      .then((r) => {
        setExecSettings(r.settings)
        setMaxAutoAmount(r.settings.max_auto_amount == null ? '' : String(r.settings.max_auto_amount))
        setMode(r.settings.auto_execute_enabled ? 'auto' : 'manual')
      }).catch(() => setExecSettings(null))
  }, [])

  const saveExecutionSettings = async (enabled: boolean) => {
    const cap = Number(maxAutoAmount)
    if (!Number.isFinite(cap) || cap <= 0) { setSettingsMessage(t('أدخل حداً أقصى موجباً أولاً.', 'Enter a positive maximum amount first.')); return }
    if (enabled && !window.confirm(t(`تفعيل تنفيذ موافقات السحب على NGPay حتى ${cap.toLocaleString('en-US')} EGP لكل عملية؟`, `Enable payout approval processing on NGPay up to ${cap.toLocaleString('en-US')} EGP per payout?`))) return
    setSettingsBusy(true); setSettingsMessage(null)
    try {
      const result = await api<{ settings: ExecSettings }>('/api/payouts/settings/execution', { method: 'PUT', body: JSON.stringify({ auto_execute_enabled: enabled, max_auto_amount: cap }) })
      setExecSettings(result.settings); setMode(result.settings.auto_execute_enabled ? 'auto' : 'manual')
      setSettingsMessage(enabled ? t('تم تفعيل التنفيذ على NGPay ضمن الحد.', 'NGPay processing enabled within the cap.') : t('تم إيقاف التنفيذ على NGPay.', 'NGPay processing disabled.'))
    } catch (e) {
      setSettingsMessage(e instanceof ApiError && e.code === 'super_admin_required' ? t('هذه الإعدادات لـ super_admin فقط.', 'Only super_admin can change these settings.') : t('تعذّر حفظ إعدادات التنفيذ.', 'Failed to save execution settings.'))
    } finally { setSettingsBusy(false) }
  }

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
    setDetailLoading(true); setDecisionErr(null); setDecisionResult(null); setProofUrl(null); setProofName(null); setRemark(''); setUtr('')
    try {
      const payout = (await api<{ payout: PayoutDetail }>(`/api/payouts/${mavenId}`)).payout
      setSelected(payout)
      setUtr(payout.linked_sms?.trx_id ?? payout.linked_sms?.trx_reference ?? '')
      if (payout.linked_sms) {
        setProofUrl(`sms-evidence:${payout.linked_sms.id}`)
        setProofName(`WD SMS #${payout.linked_sms.id}`)
      }
    }
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
    if (!selected || (decision === 'APPROVED' && !proofUrl && !selected.linked_sms)) return
    setDecisionBusy(true); setDecisionErr(null); setDecisionResult(null)
    try {
      const result = await api<DecisionResult>(`/api/payouts/${selected.maven_id}/decision`, {
        method: 'POST', body: JSON.stringify({ decision, proof_url: proofUrl?.startsWith('sms-evidence:') ? undefined : proofUrl, remark, mode: decision === 'APPROVED' ? mode : 'manual', utr_number: utr.trim() || undefined }),
      })
      setDecisionResult(result); void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') { setDecisionErr(t('حالة السحب تغيّرت بالفعل — أعد التحميل.', 'Payout status already changed — reload.')); void load() }
      else if (e instanceof ApiError && e.status === 403) setDecisionErr(t('لا تملك صلاحية الاعتماد الفعلية لهذا الدور.', 'Your role lacks approval permission.'))
      else if (e instanceof ApiError && e.code === 'worker_failed') {
        const worker = e.body?.worker as Record<string, unknown> | undefined
        setDecisionErr(`${t('رفض NGPay التنفيذ', 'NGPay processing failed')}: ${String(worker?.error ?? t('راجع الحد وUTR وحالة المعاملة.', 'Check the cap, UTR, and payout status.'))}`)
      } else setDecisionErr(t('فشل تسجيل القرار عبر عامل السحوبات.', 'Failed to record the decision via the payout worker.'))
    } finally { setDecisionBusy(false) }
  }
  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1

  return <PanelShell>
    <section className="page-head"><h2>📤 {t('السحوبات', 'Payouts')}</h2><p className="page-sub">{t('قرارات السحب تُسجّل عبر عامل القرارات مع سجل تدقيق وإثبات للمقبول.', 'Payout decisions are recorded via the decision worker with an audit trail and proof for approvals.')}{data && <> · {data.total.toLocaleString('en-US')}</>}</p></section>
    {user?.role === 'super_admin' && <section className="card payout-execution-settings">
      <div><strong>{t('تنفيذ موافقات السحب على NGPay', 'Process payout approvals on NGPay')}</strong><p className="page-sub">{t('كل موافقة تتطلب إثباتاً وUTR وتأكيداً بشرياً، ولا تتجاوز الحد لكل عملية.', 'Every approval requires proof, UTR, and human confirmation, and cannot exceed the per-payout cap.')}</p></div>
      <label><span>{t('الحد الأقصى لكل سحب (EGP)', 'Maximum per payout (EGP)')}</span><input className="login-input control-input mono" type="number" min="1" step="1" value={maxAutoAmount} onChange={(e) => setMaxAutoAmount(e.target.value)} /></label>
      <div className="control-row"><button className="btn-primary btn-sm" disabled={settingsBusy || execSettings?.auto_execute_enabled} onClick={() => void saveExecutionSettings(true)}>{t('تفعيل التنفيذ', 'Enable processing')}</button><button className="btn-ghost btn-sm danger" disabled={settingsBusy || !execSettings?.auto_execute_enabled} onClick={() => void saveExecutionSettings(false)}>{t('إيقاف', 'Disable')}</button><span className={`pay-status-badge ${execSettings?.auto_execute_enabled ? 'st-paid' : 'st-dim'}`}>{execSettings?.auto_execute_enabled ? t('NGPay مفعّل', 'NGPay enabled') : t('متوقف', 'Disabled')}</span></div>
      {settingsMessage && <p className="drawer-note">{settingsMessage}</p>}
    </section>}
    <div className="filter-bar"><div className="chip-row"><button className={`chip${status === '' ? ' chip-active' : ''}`} onClick={() => setFilter({ status: '' })}>{t('الكل', 'All')}</button>{STATUS_FILTERS.map((s) => <button key={s} className={`chip${status === s ? ' chip-active' : ''}`} onClick={() => setFilter({ status: s })}>{statusMeta(s).label}</button>)}</div><form className="search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}><input className="login-input search-input" placeholder={t('بحث: مرجع / موبايل / اسم حساب / تاجر', 'Search: ref / phone / account name / merchant')} value={q} onChange={(e) => setQ(e.target.value)} /><button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>{appliedQ && <button type="button" className="btn-ghost btn-sm" onClick={() => { setQ(''); setFilter({ q: '' }) }}>{t('مسح', 'Clear')}</button>}</form></div>
    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {loading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {!loading && data?.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
      {!loading && data && data.rows.length > 0 && <div className="table-wrap payout-ledger-wrap"><table className="data-table clickable payout-ledger-table"><thead><tr>
        <th>{t('إجراء', 'Action')}</th><th>{t('رقم المعاملة', 'Transaction ID')}</th><th>{t('مرجع التاجر', 'Merchant Reference')}</th><th>{t('الحالة', 'Status')}</th><th>{t('نوع الدفع', 'Payment Type')}</th><th>{t('رقم هاتف المستخدم', 'User Phone Num.')}</th><th>{t('اسم حساب المستخدم', 'User Account Name')}</th><th>{t('رقم حساب المستخدم', 'User Account Number')}</th><th>{t('اسم البنك', 'Bank Name')}</th><th>{t('رمز IFSC', 'Bank IFSC')}</th><th>{t('رقم UTR', 'UTR Number')}</th><th>{t('العملة', 'Currency')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('العمولة', 'Commission')}</th><th>{t('نسبة العمولة', 'Commission %')}</th><th>{t('التاجر الرئيسي', 'Master Merchant')}</th><th>{t('التاجر', 'Merchant')}</th>
      </tr></thead><tbody>{data.rows.map((row) => { const st = statusMeta(row.status); return <tr key={row.maven_id} onClick={() => void openDetail(row.maven_id)}>
        <td className="payout-action-cell" onClick={(e) => e.stopPropagation()}><div className="row-actions"><button className="btn-ghost btn-sm icon-text-btn" onClick={() => void openDetail(row.maven_id)}><Eye size={15} aria-hidden="true" />{row.status === 'PENDING' && can('payouts', 'can_approve') ? t('قرار', 'Decide') : t('تفاصيل', 'Details')}</button>{row.linked_sms && <button type="button" className="proof-icon-button is-compact payout-sms-linked" title={`WD SMS #${row.linked_sms.id} · ${row.linked_sms.trx_id ?? row.linked_sms.trx_reference ?? '—'}`} aria-label={t('رسالة سحب مرتبطة', 'Linked withdrawal SMS')} onClick={() => void openDetail(row.maven_id)}><MessageSquare size={16} aria-hidden="true" /></button>}{row.image_url && <ProofIconButton url={row.image_url} onOpen={setViewedProofUrl} compact />}</div></td>
        <td className="mono">{row.maven_id}</td><td className="mono">{row.merchant_reference ?? '—'}</td><td><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></td><td><MethodLogo method={row.payment_type} /></td><td className="mono">{row.mobile_no ?? '—'}</td><td>{row.account_name ?? '—'}</td><td className="mono">{row.user_account_number ?? '—'}</td><td>{row.bank_name ?? '—'}</td><td className="mono">{row.bank_ifsc ?? '—'}</td><td className="mono">{row.utr_number ?? '—'}</td><td className="mono">{row.currency ?? CURRENCY}</td><td className="mono">{money(row.amount, row.currency ?? CURRENCY)}</td><td className="mono">{row.commission == null ? '—' : money(row.commission, row.currency ?? CURRENCY)}</td><td className="mono">{row.commission_percentage == null ? '—' : `${row.commission_percentage.toFixed(2)}%`}</td><td>{row.master_merchant ? <MerchantLogo merchant={row.master_merchant} /> : '—'}</td><td><MerchantLogo merchant={row.merchant} /></td>
      </tr> })}</tbody></table></div>}
      {data && totalPages > 1 && <div className="pager"><button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>→ {t('السابق', 'Prev')}</button><PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setFilter({ page: 1 }) }} />
            <span className="pager-info mono">{page} / {totalPages}</span><button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>{t('التالي', 'Next')} ←</button></div>}
    </section>
    {viewedProofUrl && <ProofModal url={viewedProofUrl} title={t('إثبات الدفع', 'Payment proof')} onClose={() => setViewedProofUrl(null)} />}
    {(selected || detailLoading) && <div className="drawer-backdrop" onClick={() => !decisionBusy && setSelected(null)}><aside className="drawer" onClick={(e) => e.stopPropagation()}>{detailLoading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}{selected && <><div className="drawer-head"><h3 className="mono">{selected.ontarget_ref ?? selected.maven_id}</h3><button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button></div><div className="drawer-amount"><span className="mono">{money(selected.amount, CURRENCY)}</span><span className={`pay-status-badge ${statusMeta(selected.status).cls}`}>{statusMeta(selected.status).label}</span></div><dl className="detail-grid"><dt>{t('رقم العملية', 'Ref')}</dt><dd className="mono">{selected.maven_id}</dd><dt>{t('المستفيد', 'Beneficiary')}</dt><dd>{selected.account_name ?? '—'} {selected.mobile_no && <span className="mono">({selected.mobile_no})</span>}</dd><dt>{t('الطريقة', 'Method')}</dt><dd>{selected.pay_by ?? '—'}</dd><dt>{t('التاجر', 'Merchant')}</dt><dd>{selected.merchant ?? '—'}</dd><dt>{t('اعتمده', 'Approved by')}</dt><dd>{selected.approved_by ?? '—'}</dd></dl>{selected.image_url && <a className="pay-status-link" href={selected.image_url} target="_blank" rel="noreferrer">🧾 {t('عرض إيصال التحويل', 'View transfer receipt')}</a>}{decisionErr && <div className="card warn">{decisionErr}</div>}{decisionResult && (decisionResult.executed_on_provider ? <div className="card"><strong>{t('نُفِّذ على المزوّد وتأكّد.', 'Executed on the provider and verified.')}</strong><br />{t('حالة المزوّد بعد التنفيذ:', 'Provider status after execution:')} <span className="mono">{decisionResult.after_status ?? '—'}</span><br /><span className="mono">audit_log_id: {decisionResult.audit_log_id ?? '—'} · executed_on_provider: true</span></div> : <div className="card warn"><strong>{t('تم تسجيل القرار فقط.', 'Decision recorded only.')}</strong><br />{t('التنفيذ على بوابة المزوّد لم يتم من هنا — نفّذه بنفسك.', 'Provider execution did not happen from here — do it yourself on the portal.')}<br /><span className="mono">audit_log_id: {decisionResult.audit_log_id ?? '—'} · executed_on_provider: false</span></div>)}{selected.status === 'PENDING' && can('payouts', 'can_approve') && !decisionResult && <div className="drawer-actions"><label className="btn-ghost btn-sm" style={{ cursor: uploading ? 'wait' : 'pointer' }}>📎 {uploading ? t('جارٍ رفع الإثبات…', 'Uploading proof…') : proofName ?? t('رفع إثبات التحويل', 'Upload transfer proof')}<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden disabled={uploading} onChange={(e) => void uploadProof(e.target.files?.[0] ?? null)} /></label><textarea className="login-input" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={t('ملاحظة اختيارية', 'Optional note')} /><div className="filter-pills" role="group"><button className={`pill${mode === 'manual' ? ' active' : ''}`} onClick={() => setMode('manual')}>{t('تنفيذ يدوي', 'Manual')}</button>{execSettings?.auto_execute_enabled && <button className={`pill${mode === 'auto' ? ' active' : ''}`} onClick={() => setMode('auto')}>{t('تنفيذ آلي على المزوّد', 'Auto on provider')}</button>}</div>{mode === 'auto' && <><label className="field-label">{t('رقم التحويل UTR (إلزامي)', 'Transfer reference / UTR (required)')}</label><input className="login-input" dir="ltr" value={utr} onChange={(e) => setUtr(e.target.value)} placeholder={t('رقم التحويل الفعلي', 'The real transfer reference')} /></>}<p className="drawer-note">{mode === 'auto' ? t('سيُرسل هذا فعلياً إلى بوابة المزوّد ويُحوّل المال. المزوّد يرفض بدون رقم تحويل، ويُتحقق من النتيجة من قائمته قبل تسجيل النجاح.', 'This really posts to the provider portal and moves money. The provider refuses without a transfer reference, and the result is verified against its own list before success is recorded.') : t('الموافقة تتطلب إثباتاً مرفوعاً. القرار يُسجَّل فقط — نفّذ التحويل على بوابة المزوّد بنفسك.', 'Approval requires an uploaded proof. The decision is only recorded — move the money on the provider portal yourself.')}</p>{!execSettings?.auto_execute_enabled && <p className="cell-sub">{t('التنفيذ الآلي مُطفأ حالياً.', 'Automatic execution is currently switched off.')}</p>}<button className="btn-primary" disabled={decisionBusy || uploading || !proofUrl || (mode === 'auto' && !utr.trim())} onClick={() => void decide('APPROVED')}>{mode === 'auto' ? t('نفّذ على المزوّد', 'Execute on provider') : t('تسجيل مقبول', 'Record approved')}</button><button className="btn-ghost danger" disabled={decisionBusy || uploading} onClick={() => void decide('DECLINED')}>{t('تسجيل مرفوض', 'Record declined')}</button></div>}{selected.status === 'PENDING' && !can('payouts', 'can_approve') && <p className="drawer-note">{t('لا تملك صلاحية', 'You lack')} <span className="mono">can_approve</span> {t('الفعلية على صفحة السحوبات.', 'on the payouts page.')}</p>}</>}</aside></div>}
  </PanelShell>
}
