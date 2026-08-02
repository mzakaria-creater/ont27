import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
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
  if (!name || name === 'Manual' || name === 'auto_trigger') {
    return <span title="قرار آلي">🤖 النظام (آلي)</span>
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
  const [data, setData] = useState<DetailResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [decisionMsg, setDecisionMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!ref) return
    try {
      setData(await api<DetailResponse>(`/api/deposits/by-ref/${encodeURIComponent(ref)}`))
      setErr(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setErr('لا توجد معاملة بهذا الرقم.')
      else if (e instanceof ApiError && e.status === 403) setErr('لا تملك صلاحية عرض المعاملات.')
      else setErr('تعذّر تحميل المعاملة.')
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
          ? 'تم القرار وأُرسل لطابور التنفيذ على المزود (browser_jobs) ✅'
          : `تم القرار محلياً — لكن التنفيذ التلقائي على المزود الخارجي ${res.old_sync === 'skipped' ? 'غير مفعّل لهذا النشر' : 'فشل'} — نفّذه من غرفة التحكم.`,
      )
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') setDecisionMsg('حالة المعاملة اتغيّرت بالفعل — أعد التحميل.')
      else setDecisionMsg('فشل تنفيذ القرار — حاول مرة أخرى.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelShell>
      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}
      {d && st && (
        <div className="txd-grid">
          {/* main column */}
          <div className="txd-main">
            <section className="card recent-card">
              <div className="recent-head">
                <div>
                  <h2 className="mono" style={{ margin: 0 }}>{d.ontarget_ref ?? d.tx_id}</h2>
                  <p className="page-sub">
                    مرجع التاجر: <span className="mono">{d.merchant_tx_reference ?? '—'}</span>
                    {' · '}البوابة: <span className="mono">{d.gateway ?? '—'}</span>
                    {d.gateway !== 'NagupayP2P' && d.gateway && <span className="pay-status-badge st-under"> بيانات اختبار</span>}
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
                  <span className="pay-status-badge st-under">⚠ المبلغ المستلم أقل من المطلوب — تحتاج مراجعة يدوية</span>
                )}
              </div>

              <dl className="detail-grid">
                <dt>المُرسِل</dt><dd>{d.sender_name ?? '—'} {d.sender_number && <span className="mono">({d.sender_number})</span>}</dd>
                <dt>البريد</dt><dd className="mono small">{d.email ?? '—'}</dd>
                <dt>إلى حساب</dt><dd>{d.to_account_name ?? '—'} <span className="mono">{d.to_account_number ?? ''}</span></dd>
                <dt>البنك / الطريقة</dt><dd>{d.to_bank ?? '—'} · {d.payment_method ?? d.gateway ?? '—'}</dd>
                <dt>التاجر</dt><dd>{d.merchant ?? '—'}{d.sub_merchant && <> · فرعي: {d.sub_merchant}</>}</dd>
                <dt>الرسوم / العمولة</dt><dd className="mono">{money(d.fees, d.currency)} / {money(d.commission, d.currency)}</dd>
                <dt>GUID</dt><dd className="mono small">{d.guid ?? '—'}</dd>
                <dt>أُنشئت</dt><dd className="mono">{depositTime({ created_utc: d.created_utc })}</dd>
                <dt>آخر تعديل</dt><dd className="mono">{depositTime({ created_utc: d.modified_utc, first_seen_at: d.last_status_change })}</dd>
                {d.manual_entry && <><dt>إدخال يدوي</dt><dd>بواسطة {d.manual_entry_by ?? '—'}{d.manual_entry_note && <> — {d.manual_entry_note}</>}</dd></>}
              </dl>

              {d.proof_image_url && (
                <a className="pay-status-link" href={d.proof_image_url} target="_blank" rel="noreferrer">🧾 عرض إثبات الدفع</a>
              )}
            </section>

            {data?.sms && (
              <section className="sms-match-card card">
                <div className="sms-match-head">
                  <span className="sms-match-title">✅ رسالة SMS مطابقة</span>
                  {data.sms.sec_diff != null && <span className="match-pct mono">فارق {data.sms.sec_diff} ث</span>}
                </div>
                <div className="sms-match-text">{smsFirstLine(data.sms)}</div>
                <div className="sms-match-meta">
                  <span className="mono">{data.sms.device_name ?? '—'}{data.sms.sim_slot != null && <> · SIM {data.sms.sim_slot}</>}</span>
                  <span className="mono">استُلمت {depositTime({ first_seen_at: data.sms.received_at })}</span>
                  {data.sms.balance_after != null && <span className="mono">الرصيد بعدها {money(data.sms.balance_after, 'EGP')}</span>}
                </div>
              </section>
            )}

            {d.raw != null && (
              <section className="card recent-card">
                <details>
                  <summary className="raw-summary">🧬 البيانات الخام من {d.gateway ?? 'المزود'} (raw)</summary>
                  <pre className="raw-json mono">{JSON.stringify(d.raw, null, 2)}</pre>
                </details>
              </section>
            )}
          </div>

          {/* side column */}
          <aside className="txd-side">
            {can('deposits', 'can_approve') && (
              <section className="card recent-card">
                <div className="section-label" style={{ marginTop: 0 }}>القرار</div>
                {d.status === 'PENDING' ? (
                  <div className="drawer-actions" style={{ flexDirection: 'column' }}>
                    <button className="btn-primary" disabled={busy} onClick={() => void decide('approve')}>✅ قبول المعاملة</button>
                    <button className="btn-ghost danger" disabled={busy} onClick={() => void decide('decline')}>❌ رفض المعاملة</button>
                  </div>
                ) : (
                  <p className="drawer-note">المعاملة ليست معلّقة — القرار متاح للحالة PENDING فقط.</p>
                )}
                {can('deposits', 'can_edit') && (
                  <button className="btn-ghost btn-sm" disabled title="تعديل الحالة يدوياً — لم يُبنَ بعد في هذا البانل؛ متاح من غرفة التحكم">
                    ✏️ تعديل
                  </button>
                )}
                {decisionMsg && <p className="cell-sub" style={{ marginTop: 8 }}>{decisionMsg}</p>}
                <p className="drawer-note">
                  القبول/الرفض يُنشئ مهمة تنفيذ حقيقية في طابور <span className="mono">browser_jobs</span> بنظام
                  الأتمتة (المصدر: <span className="mono">manual_panel</span>) — لا يُعدَّل المزود مباشرة من هنا.
                </p>
              </section>
            )}

            <section className="card recent-card">
              <div className="section-label" style={{ marginTop: 0 }}>سجل النشاط</div>
              <div className="timeline" style={{ marginTop: 0 }}>
                {d.status !== 'PENDING' && (
                  <div className="timeline-item">
                    <div className={`timeline-dot ${d.status === 'PAID' || d.status === 'APPROVED' ? 'done' : 'neutral'}`} />
                    <div>
                      <div className="timeline-title">القرار: {st.label}</div>
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
                      <div className="timeline-title">استُقبلت رسالة SMS مطابقة</div>
                      <div className="timeline-meta mono">{depositTime({ first_seen_at: data.sms.received_at })} · {data.sms.device_name ?? '—'}</div>
                    </div>
                  </div>
                )}
                <div className="timeline-item">
                  <div className="timeline-dot neutral" />
                  <div>
                    <div className="timeline-title">تم إنشاء المعاملة</div>
                    <div className="timeline-meta mono">{depositTime({ created_utc: d.created_utc, first_seen_at: d.first_seen_at })} · {d.gateway ?? '—'}</div>
                  </div>
                </div>
              </div>
            </section>

            {data?.client && data.client.total > 1 && (
              <section className="card recent-card">
                <div className="section-label" style={{ marginTop: 0 }}>سجل هذا العميل</div>
                <div className="client-history" style={{ marginTop: 0 }}>
                  <div className="ch-tile"><div className="ch-value">{data.client.total}</div><div className="ch-label">إجمالي</div></div>
                  <div className="ch-tile"><div className="ch-value" style={{ color: 'var(--status-paid)' }}>{data.client.paid}</div><div className="ch-label">مقبولة</div></div>
                  <div className="ch-tile"><div className="ch-value" style={{ color: 'var(--status-declined)' }}>{data.client.declined}</div><div className="ch-label">مرفوضة</div></div>
                </div>
              </section>
            )}

            <Link to="/deposits" className="btn-ghost btn-sm">→ رجوع للإيداعات</Link>
          </aside>
        </div>
      )}
    </PanelShell>
  )
}
