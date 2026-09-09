import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import ProofModal from '../components/ProofModal'
import TransactionEditPanel from '../components/TransactionEditPanel'
import { api, ApiError } from '../lib/api'
import { depositTime, isAutomaticApprovalActor, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import type { DepositDetail } from '../lib/deposits'
import { Activity, AlertTriangle, Bot, CheckCircle2, CircleDollarSign, Clock3, Database, FileJson, History, MessageSquareText, Pencil, UserRound, Workflow } from 'lucide-react'
import DepositKindBadge from '../components/DepositKindBadge'

// تفاصيل المعاملة — full-page detail view keyed by OUR ontarget_ref.
// Handles all 7 real statuses and all 3 gateways (NagupayP2P live,
// RSC/AVADAPAY test) — raw jsonb shown collapsible, never normalized.

interface MatchedSms {
  id: number
  received_at: string | null
  device_name: string | null
  sim_slot: number | null
  sender_name: string | null
  sender_number: string | null
  receiver_number: string | null
  amount: number | null
  balance_after: number | null
  sms_first_line: string | null
  sec_diff: number | null
  matched_at: string | null
  match_status: string | null
  sms_category: string | null
  trx_id: string | null
  provider: string | null
  webhook_name: string | null
  raw_sms: string | null
  risk_score: number | null
  risk_reason: string | null
  suspicious: boolean | null
  is_duplicate: boolean | null
}

interface ClientHistory { total: number; paid: number; declined: number; pending: number; approved_total: number; first_seen_at: string | null; last_seen_at: string | null }

interface HistoryEvent {
  id: string
  type: 'audit' | 'decision' | 'edit_request' | 'edit_decision' | 'automation' | 'provider_job' | 'provider'
  title: string
  detail?: string | null
  actor?: string | null
  at?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

interface ProviderDiagnostics {
  review: Record<string, unknown> | null
  jobs: Record<string, unknown>[]
  events: Record<string, unknown>[]
}

interface DetailResponse {
  deposit: DepositDetail & { raw?: Record<string, unknown> | null; email?: string | null; is_blacklisted?: boolean }
  sms: MatchedSms | null
  client: ClientHistory | null
  history: HistoryEvent[]
  provider: ProviderDiagnostics
}

function DecisionBy({ name }: { name: string | null | undefined }) {
  const { t } = useLocale()
  if (isAutomaticApprovalActor(name)) {
    return <span className="decision-by" title={t('قرار آلي', 'Automatic decision')}><Bot size={15} aria-hidden="true" /> {t('آلي (Auto)', 'Auto')}</span>
  }
  return (
    <span className="decision-by">
      <span className="avatar-initial">{String(name).charAt(0).toUpperCase()}</span> {name}
    </span>
  )
}

function smsFirstLine(s: MatchedSms): string {
  const raw = s.sms_first_line ?? ''
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('From :'))[0] ?? '—'
}

function elapsedSeconds(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null
  return Math.round((endMs - startMs) / 1_000)
}

function formatElapsed(seconds: number | null, t: (ar: string, en: string) => string): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}${t('ث', 's')}`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}${t('د', 'm')} ${remainder}${t('ث', 's')}`
  const hours = Math.floor(minutes / 60)
  return `${hours}${t('س', 'h')} ${minutes % 60}${t('د', 'm')}`
}

function masterChip(master: string | null | undefined) {
  if (!master) return null
  const m = master.toLowerCase()
  const cls = m.includes('ngpay') ? 'ngpay' : m.includes('payfuture') ? 'payfuture' : 'other'
  return <span className={`merchant-chip ${cls}`}>{master}</span>
}

const actionLabels: Record<string, [string, string]> = {
  'transaction.edit': ['تعديل المعاملة', 'Transaction edited'],
  'transaction.edit_requested': ['طلب تعديل', 'Edit requested'],
  'transaction.edit_applied': ['تطبيق طلب التعديل', 'Edit request applied'],
  'transaction.edit_rejected': ['رفض طلب التعديل', 'Edit request rejected'],
  'deposit.approve': ['اعتماد الإيداع', 'Deposit approved'],
  'deposit.decline': ['رفض الإيداع', 'Deposit declined'],
  'deposit.maven_action_applied': ['كتابة إجراء بواسطة Maven', 'Write action by Maven'],
  'crm.sms_name_learned': ['حفظ اسم SMS للعميل', 'SMS name saved to client'],
}

function historyTitle(event: HistoryEvent, t: (ar: string, en: string) => string) {
  const known = actionLabels[event.title]
  if (known) return t(known[0], known[1])
  if (event.title.startsWith('provider_job.')) return `${t('مهمة المزوّد', 'Provider job')}: ${event.title.split('.').at(-1)}`
  if (event.title.startsWith('ngpay.')) return `NagoPay: ${event.title.split('.').at(-1)}`
  return event.title.replaceAll('_', ' ')
}

function eventIcon(type: HistoryEvent['type']) {
  if (type === 'provider' || type === 'provider_job') return Workflow
  if (type === 'edit_request' || type === 'edit_decision') return Pencil
  if (type === 'decision') return CheckCircle2
  if (type === 'automation') return Activity
  return History
}

function jsonSummary(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null
  return Object.entries(value).map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(', ') : String(item ?? '—')}`).join(' · ')
}

export default function TransactionDetail() {
  const { ref } = useParams<{ ref: string }>()
  const { can, user } = useAuth()
  const { t } = useLocale()
  const [data, setData] = useState<DetailResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [decisionMsg, setDecisionMsg] = useState<string | null>(null)
  const [proofOpen, setProofOpen] = useState(false)

  const load = useCallback(async () => {
    if (!ref) return
    try {
      setData(await api<DetailResponse>(`/api/deposits/by-ref/${encodeURIComponent(ref)}`))
      setErr(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setErr(t('لا توجد معاملة بهذا الرقم.', 'No transaction with this reference.'))
      else if (e instanceof ApiError && e.status === 403) setErr(t('لا تملك صلاحية عرض المعاملات.', 'You do not have permission to view transactions.'))
      else setErr(t('تعذّر تحميل المعاملة.', 'Failed to load the transaction.'))
    }
  }, [ref])

  useEffect(() => { void load() }, [load])

  const d = data?.deposit
  const st = d ? statusMeta(d.status) : null
  const canDirectEdit = ['super_admin', 'owner', 'admin', 'operations_admin'].includes(user?.role ?? '')
  const canUnblock = can('client_crm', 'can_edit') || can('transactions', 'can_edit') || can('risk', 'can_edit')
  const raw = d?.raw ?? {}
  const rawValue = (...keys: string[]) => keys.map((key) => raw[key]).find((value) => value != null && value !== '')

  const decide = async (action: 'approve' | 'decline') => {
    if (!d) return
    setBusy(true)
    setDecisionMsg(null)
    try {
      const res = await api<{ status: string; old_sync?: string }>(`/api/deposits/${d.tx_id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      setDecisionMsg(
        res.old_sync === 'ok'
          ? t('تم القرار وأُرسل لطابور التنفيذ على المزود (browser_jobs) ✅', 'Decision recorded and queued for provider execution (browser_jobs) ✅')
          : t(`تم القرار محلياً — لكن التنفيذ التلقائي على المزود الخارجي ${res.old_sync === 'skipped' ? 'غير مفعّل لهذا النشر' : 'فشل'} — نفّذه من غرفة التحكم.`, `Decision recorded locally — automatic provider execution ${res.old_sync === 'skipped' ? 'is not enabled for this deployment' : 'failed'} — perform it from the control room.`),
      )
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') setDecisionMsg(t('حالة المعاملة اتغيّرت بالفعل — أعد التحميل.', 'Transaction status already changed — reload.'))
      else setDecisionMsg(t('فشل تنفيذ القرار — حاول مرة أخرى.', 'Failed to apply the decision — try again.'))
    } finally {
      setBusy(false)
    }
  }

  const unblockClient = async () => {
    if (!d?.sender_number || !window.confirm(t('رفع الحظر عن رقم العميل؟', 'Unblock this client number?'))) return
    try { await api('/api/risk/blacklist/unblock-client', { method: 'POST', body: JSON.stringify({ value: d.sender_number }) }); setDecisionMsg(t('تم رفع الحظر عن العميل وتسجيل العملية.', 'Client unblocked and the action was audited.')) }
    catch { setDecisionMsg(t('تعذّر رفع الحظر — تحقق من الصلاحيات.', 'Could not unblock — check permissions.')) }
  }

  return (
    <PanelShell>
      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {d && st && (
        <div className="txd-grid">
          {/* main column */}
          <div className="txd-main">
            <section className="card recent-card">
              <div className="recent-head">
                <div>
                  <h2 className="mono" style={{ margin: 0 }}>{d.ontarget_ref ?? d.tx_id}</h2>
                  <p className="page-sub">
                    {t('مرجع التاجر', 'Merchant ref')}: <span className="mono">{d.merchant_tx_reference ?? '—'}</span>
                    {' · '}{t('البوابة', 'Gateway')}: <span className="mono">{d.gateway ?? '—'}</span>
                    {d.gateway !== 'NagupayP2P' && d.gateway && <span className="pay-status-badge st-under"> {t('بيانات اختبار', 'test data')}</span>}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {canDirectEdit && (
                    <a className="btn-primary btn-sm" href="#transaction-edit-panel">
                      <Pencil size={15} aria-hidden="true" /> {t('تعديل', 'Edit')}
                    </a>
                  )}
                  {canUnblock && d.sender_number && (d.is_blacklisted ? <button className="btn-ghost btn-sm" onClick={() => void unblockClient()}>🚫 {t('رفع حظر العميل', 'Unblock client')}</button> : <button className="btn-ghost danger btn-sm" onClick={async () => { if (window.confirm(t('حظر هذا العميل؟','Block this client?'))) { await api('/api/risk/blacklist', { method: 'POST', body: JSON.stringify({ type: 'phone', value: d.sender_number, reason: 'Blocked from transaction detail' }) }); void load() } }}>🚫 {t('حظر العميل', 'Block client')}</button>)}
                  {masterChip(d.master_merchant)}
                  <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                </div>
              </div>

              <div className="txd-amount">
                <span className="txd-amount-value mono">{money(d.amount, '')}</span>
                <span className="txd-amount-currency">{d.currency ?? 'EGP'}</span>
                {d.status === 'UNDERPAID' && (
                  <span className="pay-status-badge st-under">⚠ {t('المبلغ المستلم أقل من المطلوب — تحتاج مراجعة يدوية', 'Received amount is less than required — needs manual review')}</span>
                )}
              </div>

              <div className="txd-context-row">
                <DepositKindBadge row={d} />
                {d.ngpay_status && <span className={`provider-row-status ${st.cls}`}>NagoPay · {d.ngpay_status}</span>}
                <span className="txd-id-chip mono">tx_id · {d.tx_id}</span>
              </div>

              <div className="txd-detail-sections">
                <section className="txd-detail-block">
                  <h3><UserRound size={17} aria-hidden="true" />{t('العميل والمرسل', 'Client & sender')}</h3>
                  <dl className="detail-grid">
                    <dt>{t('اسم المرسل', 'Sender name')}</dt><dd>{d.sender_name ?? rawValue('FirstName', 'RandomName') as string ?? '—'}</dd>
                    <dt>{t('رقم العميل', 'Client number')}</dt><dd className="mono">{d.sender_number ?? rawValue('PhoneNo', 'RandomPhone') as string ?? '—'}</dd>
                    <dt>{t('البريد', 'Email')}</dt><dd className="mono small">{d.email ?? rawValue('EmailAddress', 'RandomEmail') as string ?? '—'}</dd>
                    <dt>{t('الوكيل', 'Agent')}</dt><dd>{d.agent_name ?? rawValue('AgentName') as string ?? '—'}</dd>
                    <dt>{t('الدولة / المدينة', 'Country / city')}</dt><dd>{d.country ?? rawValue('Country') as string ?? '—'} · {rawValue('City', 'State') as string ?? '—'}</dd>
                  </dl>
                </section>

                <section className="txd-detail-block">
                  <h3><CircleDollarSign size={17} aria-hidden="true" />{t('الدفع والحساب', 'Payment & account')}</h3>
                  <dl className="detail-grid">
                    <dt>{t('الحساب المخصص', 'Allocated account')}</dt><dd>{d.to_account_name ?? rawValue('ToBankAccountName', 'AccountName') as string ?? '—'} <span className="mono">{d.to_account_number ?? rawValue('ToBankAccountNumber', 'AccountNumber') as string ?? ''}</span></dd>
                    <dt>{t('محفظة الاستلام الفعلية', 'Actual receiving wallet')}</dt><dd className="mono">{d.receiving_wallet ?? '—'}</dd>
                    <dt>{t('البنك / الطريقة', 'Bank / method')}</dt><dd>{d.to_bank ?? rawValue('BankName', 'ToBankName') as string ?? '—'} · {d.payment_method ?? rawValue('iPayinfo', 'PayBy') as string ?? d.gateway ?? '—'}</dd>
                    <dt>{t('المبلغ', 'Amount')}</dt><dd className="mono">{money(d.amount, d.currency)}</dd>
                    <dt>{t('الرسوم / العمولة', 'Fees / commission')}</dt><dd className="mono">{money(d.fees, d.currency)} / {money(d.commission, d.currency)}</dd>
                    <dt>UTR</dt><dd className="mono">{rawValue('UTRNumber', 'Reference1') as string ?? '—'}</dd>
                    <dt>{t('الوصف', 'Descriptor')}</dt><dd className="mono small">{rawValue('Descriptor') as string ?? '—'}</dd>
                  </dl>
                </section>

                <section className="txd-detail-block">
                  <h3><Database size={17} aria-hidden="true" />{t('التاجر والمزوّد', 'Merchant & provider')}</h3>
                  <dl className="detail-grid">
                    <dt>{t('التاجر', 'Merchant')}</dt><dd>{d.merchant ?? rawValue('MerchantName') as string ?? '—'}</dd>
                    <dt>{t('التاجر الفرعي', 'Sub-merchant')}</dt><dd>{d.sub_merchant ?? rawValue('SiteName', 'RetailerName') as string ?? '—'}</dd>
                    <dt>{t('التاجر الرئيسي', 'Master merchant')}</dt><dd>{d.master_merchant ?? '—'}</dd>
                    <dt>{t('البوابة', 'Gateway')}</dt><dd className="mono">{d.gateway ?? rawValue('Gateway') as string ?? '—'}</dd>
                    <dt>{t('حالة NagoPay الخام', 'Raw NagoPay status')}</dt><dd className="mono">{rawValue('Status') as string ?? d.ngpay_status ?? '—'}</dd>
                    <dt>{t('استجابة المزوّد', 'Provider response')}</dt><dd>{d.response_message ?? rawValue('Response', 'GatewayResponseText', 'Description') as string ?? '—'}</dd>
                    <dt>{t('نوع الطلب', 'Request type')}</dt><dd>{d.request_type ?? rawValue('RequestType', 'Type') as string ?? '—'}</dd>
                  </dl>
                </section>

                <section className="txd-detail-block">
                  <h3><Clock3 size={17} aria-hidden="true" />{t('المراجع والتوقيت', 'References & timing')}</h3>
                  <dl className="detail-grid">
                    <dt>OnTarget ref</dt><dd className="mono">{d.ontarget_ref ?? '—'}</dd>
                    <dt>{t('مرجع التاجر', 'Merchant ref')}</dt><dd className="mono">{d.merchant_tx_reference ?? '—'}</dd>
                    <dt>GUID</dt><dd className="mono small">{d.guid ?? '—'}</dd>
                    <dt>{t('أُنشئت لدى المزوّد', 'Provider created')}</dt><dd className="mono">{depositTime({ created_utc: d.created_utc })}</dd>
                    <dt>{t('أول مزامنة', 'First sync')}</dt><dd className="mono">{depositTime({ first_seen_at: d.first_seen_at })}</dd>
                    <dt>{t('آخر تغيير حالة', 'Last status change')}</dt><dd className="mono">{depositTime({ first_seen_at: d.last_status_change })}</dd>
                    <dt>{t('آخر تعديل لدى المزوّد', 'Provider modified')}</dt><dd className="mono">{depositTime({ created_utc: d.modified_utc })}</dd>
                    <dt>{t('اعتمد بواسطة', 'Approved by')}</dt><dd><DecisionBy name={d.approved_by} /></dd>
                    {d.manual_entry && <><dt>{t('إدخال يدوي', 'Manual entry')}</dt><dd>{t('بواسطة', 'by')} {d.manual_entry_by ?? '—'}{d.manual_entry_note && <> — {d.manual_entry_note}</>}</dd></>}
                  </dl>
                </section>
              </div>

              <div className={`txd-proof-card${d.proof_image_url ? '' : ' is-empty'}`}>
                <div className="txd-proof-head"><span><Database size={17} aria-hidden="true" /> {t('إثبات المعاملة', 'Transaction proof')}</span><span className={`pay-status-badge ${d.proof_image_url ? 'st-paid' : 'st-dim'}`}>{d.proof_image_url ? t('مرفق', 'Attached') : t('غير مرفق', 'Not attached')}</span></div>
                {d.proof_image_url ? <button type="button" className="txd-proof-preview" onClick={() => setProofOpen(true)} aria-label={t('فتح إثبات الدفع', 'Open payment proof')}><img src={d.proof_image_url} alt={t('إثبات الدفع', 'Payment proof')} /><span>{t('فتح الإثبات بالحجم الكامل', 'Open full-size proof')}</span></button> : <p className="drawer-note">{t('لا توجد صورة إثبات مرفقة بهذه المعاملة.', 'No payment proof image is attached to this transaction.')}</p>}
                <div className="txd-proof-meta"><span className="mono">TRX #{d.ontarget_ref ?? d.tx_id}</span><span>{d.gateway ?? '—'}</span><span>{money(d.amount, d.currency)}</span></div>
              </div>
            </section>

            {data?.sms && (
              <section className="sms-match-card card">
                <div className="sms-match-head">
                  <span className="sms-match-title"><MessageSquareText size={17} aria-hidden="true" /> {t('بطاقة SMS المرتبطة', 'Assigned SMS proof card')}</span>
                  <span className="pay-status-badge st-paid">{t('مرتبطة 1:1', 'Assigned 1:1')}</span>
                  {data.sms.sec_diff != null && <span className="match-pct mono">{t('فارق', 'diff')} {data.sms.sec_diff}{t('ث', 's')}</span>}
                </div>
                {d.status === 'DECLINED' && <div className="declined-sms-warning-line"><AlertTriangle size={13} aria-hidden="true" /> {t('تحذير: SMS مرتبطة بمعاملة مرفوضة', 'Warning: SMS is linked to a declined transaction')}</div>}
                <div className={d.status === 'DECLINED' ? 'sms-match-text is-warning-raw' : 'sms-match-text'}>{smsFirstLine(data.sms)}</div>
                <dl className="detail-grid sms-detail-grid">
                  <dt>SMS ID / TRX</dt><dd className="mono">#{data.sms.id} · {data.sms.trx_id ?? '—'}</dd>
                  <dt>{t('المرسل', 'Sender')}</dt><dd>{data.sms.sender_name ?? '—'} {data.sms.sender_number && <span className="mono">({data.sms.sender_number})</span>}</dd>
                  <dt>{t('محفظة الاستلام', 'Receiving wallet')}</dt><dd className="mono">{data.sms.receiver_number ?? '—'}</dd>
                  <dt>{t('المبلغ / الرصيد بعده', 'Amount / balance after')}</dt><dd className="mono">{money(data.sms.amount, 'EGP')} / {money(data.sms.balance_after, 'EGP')}</dd>
                  <dt>{t('الجهاز', 'Device')}</dt><dd className="mono">{data.sms.device_name ?? data.sms.webhook_name ?? '—'}{data.sms.sim_slot != null && <> · SIM {data.sms.sim_slot}</>}</dd>
                  <dt>{t('المصدر / التصنيف', 'Provider / category')}</dt><dd>{data.sms.provider ?? '—'} · {data.sms.sms_category ?? '—'}</dd>
                  <dt>{t('نوع المطابقة', 'Match type')}</dt><dd>{data.sms.match_status ?? '—'} · {data.sms.matched_at ? depositTime({ first_seen_at: data.sms.matched_at }) : '—'}</dd>
                  <dt>{t('استُلمت', 'Received')}</dt><dd className="mono">{depositTime({ first_seen_at: data.sms.received_at })}</dd>
                  <dt>{t('المخاطر', 'Risk')}</dt><dd>{data.sms.risk_score ?? 0} · {data.sms.risk_reason ?? t('لا توجد إشارة', 'No flag')}{data.sms.suspicious && <> · {t('مشبوهة', 'Suspicious')}</>}{data.sms.is_duplicate && <> · {t('مكررة', 'Duplicate')}</>}</dd>
                </dl>
                {data.sms.raw_sms && <details className={`sms-raw${d.status === 'DECLINED' ? ' is-declined-warning' : ''}`}><summary>{t('نص الرسالة الكامل', 'Full SMS text')}</summary><pre className="raw-json mono">{data.sms.raw_sms}</pre></details>}
              </section>
            )}

            {data?.sms && (
              <section className="sms-process-card card">
                <div className="sms-match-head">
                  <span className="sms-match-title"><Clock3 size={17} aria-hidden="true" /> {t('زمن معالجة مطابقة SMS', 'SMS match processing time')}</span>
                  <span className="pay-status-badge st-paid">{t('تم الربط', 'Matched')}</span>
                </div>
                <dl className="detail-grid sms-process-grid">
                  <dt>{t('استلام الرسالة', 'SMS received')}</dt><dd className="mono">{depositTime({ first_seen_at: data.sms.received_at })}</dd>
                  <dt>{t('إتمام المطابقة', 'Match completed')}</dt><dd className="mono">{depositTime({ first_seen_at: data.sms.matched_at })}</dd>
                  <dt>{t('مدة المعالجة', 'Processing time')}</dt><dd className="mono sms-process-value">{formatElapsed(elapsedSeconds(data.sms.received_at, data.sms.matched_at), t)}</dd>
                  <dt>{t('وقت المعاملة حتى المطابقة', 'Transaction to match')}</dt><dd className="mono">{formatElapsed(elapsedSeconds(d.first_seen_at, data.sms.matched_at), t)}</dd>
                  <dt>{t('فارق التوقيت المستخدم للمطابقة', 'Matching time difference')}</dt><dd className="mono">{data.sms.sec_diff != null ? `${data.sms.sec_diff}${t('ث', 's')}` : '—'}</dd>
                  <dt>{t('قاعدة المطابقة', 'Match rule')}</dt><dd>{data.sms.match_status ?? t('مطابقة تلقائية', 'Automatic match')}</dd>
                </dl>
              </section>
            )}

            {d.raw != null && (
              <section className="card recent-card">
                <details>
                  <summary className="raw-summary"><FileJson size={16} aria-hidden="true" /> {t('البيانات الخام من', 'Raw data from')} {d.gateway ?? t('المزود', 'provider')} (raw)</summary>
                  <pre className="raw-json mono">{JSON.stringify(d.raw, null, 2)}</pre>
                </details>
              </section>
            )}
          </div>

          {/* side column */}
          <aside className="txd-side">
            {can('deposits', 'can_approve') && (
              <section className="card recent-card">
                <div className="section-label" style={{ marginTop: 0 }}>{t('القرار', 'Decision')}</div>
                {d.status === 'PENDING' ? (
                  <div className="drawer-actions" style={{ flexDirection: 'column' }}>
                    <button className="btn-primary" disabled={busy} onClick={() => void decide('approve')}>✅ {t('قبول المعاملة', 'Approve transaction')}</button>
                    <button className="btn-ghost danger" disabled={busy} onClick={() => void decide('decline')}>❌ {t('رفض المعاملة', 'Decline transaction')}</button>
                  </div>
                ) : (
                  <p className="drawer-note">{t('المعاملة ليست معلّقة — القرار متاح للحالة PENDING فقط.', 'Transaction is not pending — decisions are only available for PENDING.')}</p>
                )}
                {decisionMsg && <p className="cell-sub" style={{ marginTop: 8 }}>{decisionMsg}</p>}
                <p className="drawer-note">
                  {t('القبول/الرفض يُنشئ مهمة تنفيذ حقيقية في طابور', 'Approve/decline creates a real execution job in the')} <span className="mono">browser_jobs</span> {t('بنظام الأتمتة (المصدر:', 'automation queue (source:')} <span className="mono">manual_panel</span>{t(') — لا يُعدَّل المزود مباشرة من هنا.', ') — the provider is not modified directly from here.')}
                </p>
              </section>
            )}

            <section className="card recent-card">
              <div className="section-label txd-section-title" style={{ marginTop: 0 }}><History size={16} aria-hidden="true" />{t('سجل الإجراءات الكامل', 'Complete action history')}</div>
              <div className="timeline txd-history" style={{ marginTop: 0 }}>
                {data.history.map((event) => {
                  const Icon = eventIcon(event.type)
                  const before = jsonSummary(event.before)
                  const after = jsonSummary(event.after)
                  return <div className="timeline-item" key={event.id}>
                    <div className={`timeline-icon ${event.type === 'provider' || event.type === 'provider_job' ? 'provider' : event.type === 'decision' ? 'done' : ''}`}><Icon size={14} aria-hidden="true" /></div>
                    <div className="timeline-body">
                      <div className="timeline-title">{historyTitle(event, t)}</div>
                      {event.detail && <div className="timeline-detail">{event.detail}</div>}
                      {before && <div className="timeline-change"><b>{t('قبل', 'Before')}:</b> {before}</div>}
                      {after && <div className="timeline-change"><b>{t('بعد', 'After')}:</b> {after}</div>}
                      <div className="timeline-meta">{event.actor ?? t('النظام', 'System')} · <span className="mono">{depositTime({ first_seen_at: event.at })}</span></div>
                    </div>
                  </div>
                })}
                {data.history.length === 0 && <p className="cell-sub">{t('لا توجد إجراءات مسجلة بعد.', 'No recorded actions yet.')}</p>}
                {data?.sms && (
                  <div className="timeline-item">
                    <div className="timeline-icon done"><MessageSquareText size={14} aria-hidden="true" /></div>
                    <div><div className="timeline-title">{t('استُقبلت رسالة SMS مطابقة', 'Matched SMS received')}</div><div className="timeline-meta mono">{depositTime({ first_seen_at: data.sms.received_at })} · {data.sms.device_name ?? '—'}</div></div>
                  </div>
                )}
                <div className="timeline-item">
                  <div className="timeline-icon"><Clock3 size={14} aria-hidden="true" /></div>
                  <div><div className="timeline-title">{t('تم إنشاء المعاملة', 'Transaction created')}</div><div className="timeline-meta mono">{depositTime({ created_utc: d.created_utc, first_seen_at: d.first_seen_at })} · {d.gateway ?? '—'}</div></div>
                </div>
              </div>
            </section>

            {(data.provider.review || data.provider.jobs.length > 0 || data.provider.events.length > 0) && (
              <section className="card recent-card">
                <div className="section-label txd-section-title" style={{ marginTop: 0 }}><Workflow size={16} aria-hidden="true" />{t('تشخيص NagoPay والتنفيذ', 'NagoPay & execution diagnostics')}</div>
                <div className="txd-provider-stats">
                  <div><span>{t('قرار المحرك', 'Engine decision')}</span><strong>{String(data.provider.review?.decision ?? '—')}</strong></div>
                  <div><span>{t('درجة المطابقة', 'Match score')}</span><strong className="mono">{String(data.provider.review?.match_score ?? '—')}</strong></div>
                  <div><span>{t('مهام التنفيذ', 'Execution jobs')}</span><strong className="mono">{data.provider.jobs.length}</strong></div>
                  <div><span>{t('أحداث NagoPay', 'NagoPay events')}</span><strong className="mono">{data.provider.events.length}</strong></div>
                </div>
                {data.provider.review?.decision_reason != null && <p className="drawer-note">{String(data.provider.review.decision_reason)}</p>}
                {data.provider.jobs.map((job) => <details key={String(job.id)} className="txd-diagnostic"><summary>{t('مهمة', 'Job')} · {String(job.state ?? '—')} · {String(job.target_status ?? '—')}</summary><pre className="raw-json mono">{JSON.stringify(job, null, 2)}</pre></details>)}
              </section>
            )}

            {data?.client && data.client.total > 1 && (
              <section className="card recent-card">
                <div className="section-label" style={{ marginTop: 0 }}>{t('سجل هذا العميل', "This client's history")}</div>
                <div className="client-history" style={{ marginTop: 0 }}>
                  <div className="ch-tile"><div className="ch-value">{data.client.total}</div><div className="ch-label">{t('إجمالي', 'Total')}</div></div>
                  <div className="ch-tile"><div className="ch-value" style={{ color: 'var(--status-paid)' }}>{data.client.paid}</div><div className="ch-label">{t('مقبولة', 'Approved')}</div></div>
                  <div className="ch-tile"><div className="ch-value" style={{ color: 'var(--status-declined)' }}>{data.client.declined}</div><div className="ch-label">{t('مرفوضة', 'Declined')}</div></div>
                  <div className="ch-tile"><div className="ch-value">{data.client.pending}</div><div className="ch-label">{t('معلقة', 'Pending')}</div></div>
                </div>
                <p className="drawer-note">{t('إجمالي الإيداعات المعتمدة', 'Approved deposit total')}: <span className="mono">{money(data.client.approved_total, d.currency)}</span></p>
              </section>
            )}

            {data && (
              <TransactionEditPanel
                txId={data.deposit.tx_id}
                ontargetRef={data.deposit.ontarget_ref}
                status={data.deposit.status}
                amount={data.deposit.amount}
                currency={data.deposit.currency}
                gateway={data.deposit.gateway}
                onDone={() => void load()}
              />
            )}

            <Link to="/deposits" className="btn-ghost btn-sm">→ {t('رجوع للإيداعات', 'Back to deposits')}</Link>
          </aside>
        </div>
      )}
      {proofOpen && data?.deposit.proof_image_url && (
        <ProofModal url={data.deposit.proof_image_url} title={`${t('إثبات الدفع', 'Payment proof')} · ${data.deposit.ontarget_ref}`} onClose={() => setProofOpen(false)} />
      )}
    </PanelShell>
  )
}
