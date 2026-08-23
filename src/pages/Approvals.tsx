import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import ProofModal from '../components/ProofModal'
import EditRequestQueue from '../components/EditRequestQueue'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useBulk } from '../lib/useBulk'
import { useLocale } from '../lib/locale'
import { syncProviders } from '../lib/providerSync'
import { LayoutGrid, TableProperties } from 'lucide-react'
import MerchantLogo from '../components/MerchantLogo'
import MethodLogo from '../components/MethodLogo'

// Approvals queue — every PENDING deposit and payout in one screen with
// quick + bulk actions.

interface DepRow {
  tx_id: number
  ontarget_ref: string | null
  merchant_tx_reference: string | null
  status: string
  amount: number | null
  currency: string | null
  sender_name: string | null
  sender_number: string | null
  payment_method: string | null
  merchant: string | null
  master_merchant: string | null
  first_seen_at: string | null
  created_utc: string | null
  proof_image_url: string | null
  to_account_number: string | null
  to_account_name: string | null
  receiving_wallet: string | null
  to_bank: string | null
  linked_sms?: { id: number; received_at: string | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; amount: number | null; sms_first_line: string | null; match_status: string | null; matched: boolean | null } | null
  decision_context?: { decision?: string | null; decision_reason?: string | null; reason?: string | null; match_score?: number | null; match_reasons?: unknown; actor_name?: string | null } | null
}

interface PayRow {
  maven_id: number
  ontarget_ref: string | null
  status: string
  amount: number | null
  pay_by: string | null
  merchant: string | null
  account_name: string | null
  mobile_no: string | null
  first_seen_at: string | null
  created_utc: string | null
}

export default function Approvals() {
  const { can } = useAuth()
  const { t } = useLocale()
  const [deposits, setDeposits] = useState<DepRow[] | null>(null)
  const [payouts, setPayouts] = useState<PayRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [proof, setProof] = useState<{ url: string; ref: string } | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(() => localStorage.getItem('approval-queue-view') === 'cards' ? 'cards' : 'table')

  const changeView = (mode: 'table' | 'cards') => {
    setViewMode(mode)
    localStorage.setItem('approval-queue-view', mode)
  }

  const load = useCallback(async () => {
    try {
      // Approval decisions must be based on the provider's current state, not
      // the last background copy. This shared pump is throttled server-side.
      await syncProviders()
      const res = await api<{ deposits: DepRow[]; payouts: PayRow[] }>('/api/approvals')
      setDeposits(res.deposits)
      setPayouts(res.payouts)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض طابور الموافقات.', 'You do not have permission to view the approval queue.') : t('تعذّر تحميل الطابور.', 'Failed to load the queue.'))
    }
  }, [])

  useEffect(() => {
    void load()
    const iv = setInterval(() => void load(), 8_000)
    return () => clearInterval(iv)
  }, [load])

  const depBulk = useBulk((id) => `/api/deposits/${id}/decision`, () => void load())
  const quick = async (id: number, action: 'approve' | 'decline') => {
    setRowBusy(`deposits-${id}`)
    try {
      await api(`/api/deposits/${id}/decision`, { method: 'POST', body: JSON.stringify({ action }) })
      setDeposits((current) => current?.filter((row) => row.tx_id !== id) ?? current)
      void load()
    } catch {
      setErr(t('فشل تنفيذ القرار — أعد المحاولة.', 'Failed to apply the decision — try again.'))
    } finally {
      setRowBusy(null)
    }
  }

  const canDep = can('deposits', 'can_approve')

  return (
    <PanelShell>
      <section className="page-head">
        <div>
          <h2>✅ {t('طابور الموافقات', 'Approval queue')}</h2>
        <p className="page-sub">
          {t('كل المعلّق في مكان واحد · تحديث تلقائي كل 30 ثانية', 'Everything pending in one place · auto-refresh every 30s')}
          {deposits && payouts && <> · {deposits.length + payouts.length} {t('بانتظار قرار', 'awaiting decision')}</>}
        </p>
        </div>
        <div className="view-switch" role="group" aria-label={t('طريقة العرض', 'View mode')}>
          <button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => changeView('table')}><TableProperties size={16} /> {t('جدول', 'Table')}</button>
          <button className={viewMode === 'cards' ? 'active' : ''} aria-pressed={viewMode === 'cards'} onClick={() => changeView('cards')}><LayoutGrid size={16} /> {t('بطاقات', 'Cards')}</button>
        </div>
      </section>

      <EditRequestQueue />

      {err && <div className="card warn">{err}</div>}

      {/* deposits */}
      <section className="card recent-card">
        <div className="recent-head">
          <h3>💰 {t('إيداعات معلّقة', 'Pending deposits')} {deposits && <span className="mono">({deposits.length})</span>}</h3>
          <Link to="/deposits?status=PENDING" className="pay-status-link">{t('فتح صفحة الإيداعات ←', 'Open deposits page →')}</Link>
        </div>
        {depBulk.progress && <div className="card bulk-progress">{depBulk.progress}</div>}
        {depBulk.selected.size > 0 && canDep && (
          <div className="bulk-bar">
            <span>{depBulk.selected.size} {t('محدد', 'selected')}</span>
            <button className="btn-primary btn-sm" disabled={depBulk.busy} onClick={() => void depBulk.run('approve')}>✅ {t('اعتماد الكل', 'Approve all')}</button>
            <button className="btn-ghost danger btn-sm" disabled={depBulk.busy} onClick={() => void depBulk.run('decline')}>❌ {t('رفض الكل', 'Decline all')}</button>
          </div>
        )}
        {!deposits && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {deposits && deposits.length === 0 && <p>{t('لا توجد إيداعات معلّقة 🎉', 'No pending deposits 🎉')}</p>}
        {deposits && deposits.length > 0 && viewMode === 'table' && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {canDep && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        checked={deposits.length > 0 && deposits.every((r) => depBulk.selected.has(r.tx_id))}
                        onChange={() => depBulk.toggleAll(deposits.map((r) => r.tx_id))}
                      />
                    </th>
                  )}
                  <th>{t('الإثبات', 'Proof')}</th>
                  <th>{t('رقم العملية', 'Ref')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('العميل / المُرسِل', 'Customer / sender')}</th>
                  <th>{t('المحفظة المستلِمة', 'Receiving wallet')}</th>
                  <th>{t('SMS المرتبطة', 'Linked SMS')}</th>
                  <th>{t('سبب القرار', 'Decision reason')}</th>
                  <th>{t('الطريقة', 'Method')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('الوقت', 'Time')}</th>
                  <th>{t('إجراء', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((r) => (
                  <tr key={r.tx_id} className="row-pending">
                    {canDep && (
                      <td className="check-col">
                        <input type="checkbox" checked={depBulk.selected.has(r.tx_id)} onChange={() => depBulk.toggle(r.tx_id)} />
                      </td>
                    )}
                    <td>
                      {r.proof_image_url ? (
                        <button
                          type="button"
                          className="proof-thumb-btn"
                          title={t('عرض إثبات الدفع', 'View payment proof')}
                          aria-label={t(`عرض إثبات الدفع للعملية ${r.ontarget_ref ?? r.tx_id}`, `View payment proof for ${r.ontarget_ref ?? r.tx_id}`)}
                          onClick={() => setProof({ url: r.proof_image_url!, ref: String(r.ontarget_ref ?? r.tx_id) })}
                        >
                          <img src={r.proof_image_url} alt="" loading="lazy" />
                        </button>
                      ) : (
                        <span className="cell-sub">{t('بدون', 'None')}</span>
                      )}
                    </td>
                    <td className="mono">
                      {r.ontarget_ref ?? r.tx_id}
                      {r.merchant_tx_reference && <div className="cell-sub mono">{r.merchant_tx_reference}</div>}
                    </td>
                    <td className="mono">{money(r.amount, r.currency)}</td>
                    <td>{r.sender_name ?? '—'}{r.sender_number && <div className="cell-sub mono">{r.sender_number}</div>}</td>
                    <td>
                      <span className="mono">{r.receiving_wallet ?? r.to_account_number ?? '—'}</span>
                      {(r.to_account_name ?? r.to_bank) && <div className="cell-sub">{r.to_account_name ?? r.to_bank}</div>}
                    </td>
                    <td className="approval-evidence-cell">
                      {r.linked_sms ? <><span className="pay-status-badge st-paid">SMS #{r.linked_sms.id}</span><div>{r.linked_sms.sender_name ?? r.linked_sms.sender_number ?? '—'}</div><div className="cell-sub mono">{money(r.linked_sms.amount, 'EGP')} · {r.linked_sms.receiver_number ?? '—'}</div><div className="cell-sub approval-sms-line">{r.linked_sms.sms_first_line ?? '—'}</div></> : <span className="pay-status-badge st-dim">{t('لا توجد SMS', 'No SMS')}</span>}
                    </td>
                    <td className="approval-reason-cell">
                      {r.decision_context ? <><strong>{r.decision_context.decision ?? t('مراجعة', 'Review')}</strong><div className="cell-sub">{r.decision_context.decision_reason ?? r.decision_context.reason ?? '—'}</div>{r.decision_context.match_score != null && <div className="cell-sub mono">score {r.decision_context.match_score}</div>}</> : <span className="cell-sub">{r.linked_sms ? t('SMS مرتبطة — بانتظار قرار', 'SMS linked — awaiting decision') : t('لا توجد مطابقة مؤكدة', 'No confirmed match')}</span>}
                    </td>
                    <td><MethodLogo method={r.payment_method} /></td>
                    <td><MerchantLogo merchant={r.merchant ?? r.master_merchant} /></td>
                    <td className="mono">{depositTime(r)}</td>
                    <td>
                      {canDep && (
                        <div className="row-actions">
                          <button className="btn-primary btn-sm" disabled={rowBusy === `deposits-${r.tx_id}`} onClick={() => void quick(r.tx_id, 'approve')}>✅</button>
                          <button className="btn-ghost danger btn-sm" disabled={rowBusy === `deposits-${r.tx_id}`} onClick={() => void quick(r.tx_id, 'decline')}>❌</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {deposits && deposits.length > 0 && viewMode === 'cards' && (
          <div className="approval-card-grid">
            {deposits.map((r) => (
              <article className="approval-item-card" key={r.tx_id}>
                <div className="approval-card-head">
                  <div>{canDep && <input type="checkbox" aria-label={t('تحديد المعاملة', 'Select transaction')} checked={depBulk.selected.has(r.tx_id)} onChange={() => depBulk.toggle(r.tx_id)} />}<Link to={`/transactions/${encodeURIComponent(r.ontarget_ref ?? String(r.tx_id))}`} className="mono approval-card-ref">{r.ontarget_ref ?? r.tx_id}</Link></div>
                  <span className="pay-status-badge st-pending">{t('معلّقة', 'Pending')}</span>
                </div>
                <div className="approval-card-amount">{money(r.amount, r.currency)}</div>
                <div className="approval-card-party"><strong>{r.sender_name ?? t('مرسل غير معروف', 'Unknown sender')}</strong><span className="mono">{r.sender_number ?? '—'}</span></div>
                <dl className="approval-card-facts">
                  <div><dt>{t('المحفظة', 'Wallet')}</dt><dd className="mono">{r.receiving_wallet ?? r.to_account_number ?? '—'}</dd></div>
                  <div><dt>{t('الطريقة', 'Method')}</dt><dd><MethodLogo method={r.payment_method} /></dd></div>
                  <div><dt>{t('التاجر', 'Merchant')}</dt><dd><MerchantLogo merchant={r.merchant ?? r.master_merchant} /></dd></div>
                  <div><dt>{t('الوقت', 'Time')}</dt><dd>{depositTime(r)}</dd></div>
                </dl>
                <div className={`approval-card-evidence ${r.linked_sms ? 'matched' : 'missing'}`}>
                  <strong>{r.linked_sms ? `SMS #${r.linked_sms.id}` : t('لا توجد SMS مطابقة', 'No matched SMS')}</strong>
                  {r.linked_sms && <><span>{r.linked_sms.sender_name ?? r.linked_sms.sender_number ?? '—'} · {money(r.linked_sms.amount, 'EGP')}</span><small>{r.linked_sms.sms_first_line ?? '—'}</small></>}
                </div>
                <div className="approval-card-reason"><span>{t('سبب المراجعة', 'Review reason')}</span><strong>{r.decision_context?.decision_reason ?? r.decision_context?.reason ?? (r.linked_sms ? t('SMS مرتبطة — بانتظار قرار', 'SMS linked — awaiting decision') : t('لا توجد مطابقة مؤكدة', 'No confirmed match'))}</strong>{r.decision_context?.match_score != null && <small className="mono">score {r.decision_context.match_score}</small>}</div>
                {r.proof_image_url && <button className="approval-card-proof" onClick={() => setProof({ url: r.proof_image_url!, ref: String(r.ontarget_ref ?? r.tx_id) })}><img src={r.proof_image_url} alt="" loading="lazy" /><span>{t('عرض إثبات الدفع', 'View payment proof')}</span></button>}
                {canDep && <div className="approval-card-actions"><button className="btn-primary" disabled={rowBusy === `deposits-${r.tx_id}`} onClick={() => void quick(r.tx_id, 'approve')}>{t('موافقة', 'Approve')}</button><button className="btn-ghost danger" disabled={rowBusy === `deposits-${r.tx_id}`} onClick={() => void quick(r.tx_id, 'decline')}>{t('رفض', 'Decline')}</button></div>}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* payouts */}
      <section className="card recent-card">
        <div className="recent-head">
          <h3>📤 {t('سحوبات معلّقة', 'Pending payouts')} {payouts && <span className="mono">({payouts.length})</span>}</h3>
          <Link to="/payouts?status=PENDING" className="pay-status-link">{t('فتح صفحة السحوبات ←', 'Open payouts page →')}</Link>
        </div>
        <p className="drawer-note">{t('تسجيل قرارات السحب يتم من صفحة السحوبات فقط، حيث يلزم رفع إثبات للمقبول ويظهر بوضوح أن تنفيذ المزود يدوي.', 'Payout decisions are recorded from the payouts page only, where a proof upload is required for approvals and provider execution is clearly manual.')}</p>
        {!payouts && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {payouts && payouts.length === 0 && <p>{t('لا توجد سحوبات معلّقة 🎉', 'No pending payouts 🎉')}</p>}
        {payouts && payouts.length > 0 && viewMode === 'table' && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('رقم العملية', 'Ref')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('المستفيد', 'Beneficiary')}</th>
                  <th>{t('الطريقة', 'Method')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('الوقت', 'Time')}</th>
                  <th>{t('إجراء', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((r) => (
                  <tr key={r.maven_id} className="row-pending">
                    <td className="mono">{r.ontarget_ref ?? r.maven_id}<div className="cell-sub mono">{r.maven_id}</div></td>
                    <td className="mono">{money(r.amount, 'EGP')}</td>
                    <td>{r.account_name ?? '—'}{r.mobile_no && <div className="cell-sub mono">{r.mobile_no}</div>}</td>
                    <td><MethodLogo method={r.pay_by} /></td>
                    <td><MerchantLogo merchant={r.merchant} /></td>
                    <td className="mono">{depositTime(r)}</td>
                    <td><Link to={`/payouts?status=PENDING&q=${encodeURIComponent(r.ontarget_ref ?? String(r.maven_id))}`} className="btn-ghost btn-sm">{t('فتح السحب', 'Open payout')}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {payouts && payouts.length > 0 && viewMode === 'cards' && (
          <div className="approval-card-grid payout-card-grid">
            {payouts.map((r) => <article className="approval-item-card" key={r.maven_id}>
              <div className="approval-card-head"><span className="mono approval-card-ref">{r.ontarget_ref ?? r.maven_id}</span><span className="pay-status-badge st-pending">{t('سحب معلّق', 'Pending payout')}</span></div>
              <div className="approval-card-amount">{money(r.amount, 'EGP')}</div>
              <div className="approval-card-party"><strong>{r.account_name ?? t('مستفيد غير معروف', 'Unknown beneficiary')}</strong><span className="mono">{r.mobile_no ?? '—'}</span></div>
              <dl className="approval-card-facts"><div><dt>{t('الطريقة', 'Method')}</dt><dd><MethodLogo method={r.pay_by} /></dd></div><div><dt>{t('التاجر', 'Merchant')}</dt><dd><MerchantLogo merchant={r.merchant} /></dd></div><div><dt>{t('رقم المزود', 'Provider ID')}</dt><dd className="mono">{r.maven_id}</dd></div><div><dt>{t('الوقت', 'Time')}</dt><dd>{depositTime(r)}</dd></div></dl>
              <Link to={`/payouts?status=PENDING&q=${encodeURIComponent(r.ontarget_ref ?? String(r.maven_id))}`} className="btn-primary approval-card-open">{t('فتح السحب واتخاذ القرار', 'Open payout and decide')}</Link>
            </article>)}
          </div>
        )}
      </section>

      {proof && (
        <ProofModal
          url={proof.url}
          title={`${t('إثبات الدفع', 'Payment proof')} · ${proof.ref}`}
          onClose={() => setProof(null)}
        />
      )}
    </PanelShell>
  )
}
