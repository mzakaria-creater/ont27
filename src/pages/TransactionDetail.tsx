import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import ProofModal from '../components/ProofModal'
import TransactionEditPanel from '../components/TransactionEditPanel'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import type { DepositDetail } from '../lib/deposits'

// تفاصيل المعاملة — full-page detail view keyed by OUR ontarget_ref.
// Handles all 7 real statuses and all 3 gateways (NagupayP2P live,
// RSC/AVADAPAY test) — raw jsonb shown collapsible, never normalized.

interface MatchedSms {
  id: number
  received_at: string | null
  device_name: string | null
  sim_slot: number | null
  sender_name: string | null
  amount: number | null
  balance_after: number | null
  sms_first_line: string | null
  sec_diff: number | null
}

interface ClientHistory { total: number; paid: number; declined: number }

interface DetailResponse {
  deposit: DepositDetail & { raw?: Record<string, unknown> | null; email?: string | null }
  sms: MatchedSms | null
  client: ClientHistory | null
}

function DecisionBy({ name }: { name: string | null | undefined }) {
  const { t } = useLocale()
  if (!name || name === 'Manual' || name === 'auto_trigger') {
    return <span title={t('قرار آلي', 'Automatic decision')}>🤖 {t('النظام (آلي)', 'System (auto)')}</span>
  }
  return (
    <span className="decision-by">
      <span className="avatar-initial">{name.charAt(0).toUpperCase()}</span> {name}
    </span>
  )
}

function smsFirstLine(s: MatchedSms): string {
  const raw = s.sms_first_line ?? ''
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('From :'))[0] ?? '—'
}

function masterChip(master: string | null | undefined) {
  if (!master) return null
  const m = master.toLowerCase()
  const cls = m.includes('ngpay') ? 'ngpay' : m.includes('payfuture') ? 'payfuture' : 'other'
  return <span className={`merchant-chip ${cls}`}>{master}</span>
}

export default function TransactionDetail() {
  const { ref } = useParams<{ ref: string }>()
  const { can } = useAuth()
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

              <dl className="detail-grid">
                <dt>{t('المُرسِل', 'Sender')}</dt><dd>{d.sender_name ?? '—'} {d.sender_number && <span className="mono">({d.sender_number})</span>}</dd>
                <dt>{t('البريد', 'Email')}</dt><dd className="mono small">{d.email ?? '—'}</dd>
                <dt>{t('إلى حساب', 'To account')}</dt><dd>{d.to_account_name ?? '—'} <span className="mono">{d.to_account_number ?? ''}</span></dd>
                <dt>{t('البنك / الطريقة', 'Bank / method')}</dt><dd>{d.to_bank ?? '—'} · {d.payment_method ?? d.gateway ?? '—'}</dd>
                <dt>{t('التاجر', 'Merchant')}</dt><dd>{d.merchant ?? '—'}{d.sub_merchant && <> · {t('فرعي', 'sub')}: {d.sub_merchant}</>}</dd>
                <dt>{t('الرسوم / العمولة', 'Fees / commission')}</dt><dd className="mono">{money(d.fees, d.currency)} / {money(d.commission, d.currency)}</dd>
                <dt>GUID</dt><dd className="mono small">{d.guid ?? '—'}</dd>
                <dt>{t('أُنشئت', 'Created')}</dt><dd className="mono">{depositTime({ created_utc: d.created_utc })}</dd>
                <dt>{t('آخر تعديل', 'Last modified')}</dt><dd className="mono">{depositTime({ created_utc: d.modified_utc, first_seen_at: d.last_status_change })}</dd>
                {d.manual_entry && <><dt>{t('إدخال يدوي', 'Manual entry')}</dt><dd>{t('بواسطة', 'by')} {d.manual_entry_by ?? '—'}{d.manual_entry_note && <> — {d.manual_entry_note}</>}</dd></>}
              </dl>

              {d.proof_image_url && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => setProofOpen(true)} aria-label={t('عرض إثبات الدفع', 'View payment proof')}>🧾 {t('عرض إثبات الدفع', 'View payment proof')}</button>
              )}
            </section>

            {data?.sms && (
              <section className="sms-match-card card">
                <div className="sms-match-head">
                  <span className="sms-match-title">✅ {t('رسالة SMS مطابقة', 'Matched SMS')}</span>
                  {data.sms.sec_diff != null && <span className="match-pct mono">{t('فارق', 'diff')} {data.sms.sec_diff}{t('ث', 's')}</span>}
                </div>
                <div className="sms-match-text">{smsFirstLine(data.sms)}</div>
                <div className="sms-match-meta">
                  <span className="mono">{data.sms.device_name ?? '—'}{data.sms.sim_slot != null && <> · SIM {data.sms.sim_slot}</>}</span>
                  <span className="mono">{t('استُلمت', 'received')} {depositTime({ first_seen_at: data.sms.received_at })}</span>
                  {data.sms.balance_after != null && <span className="mono">{t('الرصيد بعدها', 'balance after')} {money(data.sms.balance_after, 'EGP')}</span>}
                </div>
              </section>
            )}

            {d.raw != null && (
              <section className="card recent-card">
                <details>
                  <summary className="raw-summary">🧬 {t('البيانات الخام من', 'Raw data from')} {d.gateway ?? t('المزود', 'provider')} (raw)</summary>
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
                {can('deposits', 'can_edit') && (
                  <button className="btn-ghost btn-sm" disabled title={t('تعديل الحالة يدوياً — لم يُبنَ بعد في هذا البانل؛ متاح من غرفة التحكم', 'Manual status edit — not built in this panel yet; available from the control room')}>
                    ✏️ {t('تعديل', 'Edit')}
                  </button>
                )}
                {decisionMsg && <p className="cell-sub" style={{ marginTop: 8 }}>{decisionMsg}</p>}
                <p className="drawer-note">
                  {t('القبول/الرفض يُنشئ مهمة تنفيذ حقيقية في طابور', 'Approve/decline creates a real execution job in the')} <span className="mono">browser_jobs</span> {t('بنظام الأتمتة (المصدر:', 'automation queue (source:')} <span className="mono">manual_panel</span>{t(') — لا يُعدَّل المزود مباشرة من هنا.', ') — the provider is not modified directly from here.')}
                </p>
              </section>
            )}

            <section className="card recent-card">
              <div className="section-label" style={{ marginTop: 0 }}>{t('سجل النشاط', 'Activity log')}</div>
              <div className="timeline" style={{ marginTop: 0 }}>
                {d.status !== 'PENDING' && (
                  <div className="timeline-item">
                    <div className={`timeline-dot ${d.status === 'PAID' || d.status === 'APPROVED' ? 'done' : 'neutral'}`} />
                    <div>
                      <div className="timeline-title">{t('القرار', 'Decision')}: {st.label}</div>
                      <div className="timeline-meta">
                        <DecisionBy name={d.approved_by} />
                        <span className="mono"> · {depositTime({ first_seen_at: d.last_status_change })}</span>
                      </div>
                    </div>
                  </div>
                )}
                {data?.sms && (
                  <div className="timeline-item">
                    <div className="timeline-dot done" />
                    <div>
                      <div className="timeline-title">{t('استُقبلت رسالة SMS مطابقة', 'Matched SMS received')}</div>
                      <div className="timeline-meta mono">{depositTime({ first_seen_at: data.sms.received_at })} · {data.sms.device_name ?? '—'}</div>
                    </div>
                  </div>
                )}
                <div className="timeline-item">
                  <div className="timeline-dot neutral" />
                  <div>
                    <div className="timeline-title">{t('تم إنشاء المعاملة', 'Transaction created')}</div>
                    <div className="timeline-meta mono">{depositTime({ created_utc: d.created_utc, first_seen_at: d.first_seen_at })} · {d.gateway ?? '—'}</div>
                  </div>
                </div>
              </div>
            </section>

            {data?.client && data.client.total > 1 && (
              <section className="card recent-card">
                <div className="section-label" style={{ marginTop: 0 }}>{t('سجل هذا العميل', "This client's history")}</div>
                <div className="client-history" style={{ marginTop: 0 }}>
                  <div className="ch-tile"><div className="ch-value">{data.client.total}</div><div className="ch-label">{t('إجمالي', 'Total')}</div></div>
                  <div className="ch-tile"><div className="ch-value" style={{ color: 'var(--status-paid)' }}>{data.client.paid}</div><div className="ch-label">{t('مقبولة', 'Approved')}</div></div>
                  <div className="ch-tile"><div className="ch-value" style={{ color: 'var(--status-declined)' }}>{data.client.declined}</div><div className="ch-label">{t('مرفوضة', 'Declined')}</div></div>
                </div>
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
