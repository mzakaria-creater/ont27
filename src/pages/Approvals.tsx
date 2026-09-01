import { useCallback, useEffect, useRef, useState } from 'react'
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
import { LayoutGrid, Search, TableProperties, X } from 'lucide-react'
import MerchantLogo from '../components/MerchantLogo'
import MethodLogo from '../components/MethodLogo'
import SenderIdentity from '../components/SenderIdentity'
import { supabase } from '../lib/supabase'

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
  sender_account_number: string | null
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
  deposit_kind?: 'first_deposit' | 'retention_deposit' | null
  previous_approved_deposits?: number | null
  client_status_counts?: { paid: number; declined: number; pending: number } | null
  wallet_status_counts?: { paid: number; declined: number; pending: number } | null
  linked_sms?: { id: number; received_at: string | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; amount: number | null; sms_first_line: string | null; match_status: string | null; matched: boolean | null } | null
  decision_context?: { decision?: string | null; decision_reason?: string | null; reason?: string | null; match_score?: number | null; match_reasons?: unknown; actor_name?: string | null } | null
}

function DepositKindBadge({ kind, count }: { kind?: DepRow['deposit_kind']; count?: number | null }) {
  if (kind === 'retention_deposit') return <span className="deposit-kind is-retention">↻ Retention deposit{count ? ` · ${count}` : ''}</span>
  return <span className="deposit-kind is-first">★ First deposit</span>
}

function AutomationCountdown({ row, now }: { row: DepRow; now: number }) {
  if (row.linked_sms) return <div className="approval-automation-ready">⚡ SMS linked · ready for fast approval</div>
  const started = new Date(row.created_utc ?? row.first_seen_at ?? '').getTime()
  if (!Number.isFinite(started)) return null
  const remaining = Math.max(0, 5 * 60 * 1000 - (now - started))
  const seconds = Math.ceil(remaining / 1000)
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0')
  const ss = (seconds % 60).toString().padStart(2, '0')
  return <div className={`approval-automation-countdown ${remaining === 0 ? 'expired' : ''}`}>⏱ Auto-decline in <strong>{remaining === 0 ? 'due' : `${mm}:${ss}`}</strong></div>
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

interface RetentionSummary {
  paid: number
  declined: number
  pending: number
  total: number
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
  const [searchQuery, setSearchQuery] = useState('')
  const [retentionSummary, setRetentionSummary] = useState<RetentionSummary>({ paid: 0, declined: 0, pending: 0, total: 0 })
  const [now, setNow] = useState(() => Date.now())
  const refreshTimer = useRef<number | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const changeView = (mode: 'table' | 'cards') => {
    setViewMode(mode)
    localStorage.setItem('approval-queue-view', mode)
  }

  const load = useCallback(async () => {
    try {
      // The queue is served from the local mirror. Never wait for a provider
      // pull before painting it; provider sync runs independently below.
      const res = await api<{ deposits: DepRow[]; payouts: PayRow[]; retention_summary?: RetentionSummary }>('/api/approvals')
      setDeposits((current) => JSON.stringify(current) === JSON.stringify(res.deposits) ? current : res.deposits)
      setPayouts((current) => JSON.stringify(current) === JSON.stringify(res.payouts) ? current : res.payouts)
      setRetentionSummary(res.retention_summary ?? { paid: 0, declined: 0, pending: 0, total: 0 })
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض طابور الموافقات.', 'You do not have permission to view the approval queue.') : t('تعذّر تحميل الطابور.', 'Failed to load the queue.'))
    }
  }, [])

  useEffect(() => {
    void load()
    // Realtime changes update the queue without a full provider sync or a
    // polling storm. A tiny debounce coalesces transaction + SMS changes.
    const schedule = () => {
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void load() }, 120)
    }
    const channel = supabase.channel('approval-queue-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maven_transactions' }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbound_sms' }, schedule)
      .subscribe()
    const syncIv = window.setInterval(() => {
      void syncProviders().then((changed) => { if (changed) schedule() })
    }, 30_000)
    const fallbackIv = window.setInterval(() => void load(), 30_000)
    return () => {
      window.clearInterval(syncIv)
      window.clearInterval(fallbackIv)
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
      void supabase.removeChannel(channel)
    }
  }, [load])

  const depBulk = useBulk((id) => `/api/deposits/${id}/decision`, () => void load())
  const quick = async (id: number, action: 'approve' | 'decline') => {
    setRowBusy(`deposits-${id}`)
    try {
      await api(`/api/deposits/${id}/decision`, { method: 'POST', body: JSON.stringify({ action }) })
      setDeposits((current) => current?.filter((row) => row.tx_id !== id) ?? current)
      // The decision endpoint already updated the local live row. Refresh the
      // queue only; do not start another provider-wide sync after every click.
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'outside_assigned_scope') {
        setErr(t('المعاملة خارج نطاق تعيين هذا المشغّل (الصلاحية أو نوع الطلب/التاجر). راجع نطاقات المستخدم.', 'This transaction is outside the operator assignment scope (permission or request type/merchant). Review the user scopes.'))
      } else if (e instanceof ApiError && e.code === 'not_pending') {
        setErr(t('المعاملة لم تعد معلّقة — تم تحديثها من مصدر آخر.', 'This transaction is no longer pending — it was updated elsewhere.'))
      } else {
        setErr(t('فشل تنفيذ القرار — أعد المحاولة.', 'Failed to apply the decision — try again.'))
      }
    } finally {
      setRowBusy(null)
    }
  }

  const canDep = can('deposits', 'can_approve')
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const visibleDeposits = deposits?.filter((row) => !normalizedSearch || [row.tx_id, row.ontarget_ref, row.merchant_tx_reference, row.amount, row.sender_name, row.sender_number, row.sender_account_number, row.receiving_wallet, row.to_account_number, row.merchant, row.master_merchant].some((value) => String(value ?? '').toLocaleLowerCase().includes(normalizedSearch))) ?? []
  const visiblePayouts = payouts?.filter((row) => !normalizedSearch || [row.maven_id, row.ontarget_ref, row.amount, row.account_name, row.mobile_no, row.pay_by, row.merchant].some((value) => String(value ?? '').toLocaleLowerCase().includes(normalizedSearch))) ?? []

  return (
    <PanelShell>
      <section className="page-head">
        <div>
          <h2>✅ {t('طابور الموافقات', 'Approval queue')}</h2>
        <p className="page-sub">
          {t('كل المعلّق في مكان واحد · تحديث لحظي مع مزامنة المزود', 'Everything pending in one place · realtime updates with provider sync')}
          {deposits && payouts && <> · {deposits.length + payouts.length} {t('بانتظار قرار', 'awaiting decision')}</>}
        </p>
        </div>
        <div className="view-switch" role="group" aria-label={t('طريقة العرض', 'View mode')}>
          <button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => changeView('table')}><TableProperties size={16} /> {t('جدول', 'Table')}</button>
          <button className={viewMode === 'cards' ? 'active' : ''} aria-pressed={viewMode === 'cards'} onClick={() => changeView('cards')}><LayoutGrid size={16} /> {t('بطاقات', 'Cards')}</button>
        </div>
      </section>

      <EditRequestQueue />

      <form className="filter-bar approval-search-bar trx-search-bar" role="search" onSubmit={(event) => event.preventDefault()}>
        <Search size={17} aria-hidden="true"/>
        <input type="search" className="login-input search-input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} aria-label={t('بحث طابور الموافقات', 'Search approval queue')} placeholder={t('بحث: رقم العملية / المبلغ / العميل / الهاتف / المحفظة / التاجر…', 'Search: transaction / amount / customer / phone / wallet / merchant…')}/>
        {searchQuery && <button type="button" className="trx-search-clear" onClick={() => setSearchQuery('')} aria-label={t('مسح البحث', 'Clear search')}><X size={15}/></button>}
        <span className="approval-search-count mono">{visibleDeposits.length + visiblePayouts.length}</span>
      </form>

      {err && <div className="card warn">{err}</div>}

      <section className="card retention-summary-card" aria-label={t('ملخص الإيداعات المتكررة', 'Retention deposit summary')}>
        <div className="recent-head">
          <div>
            <h3>↻ {t('Retention deposits', 'Retention deposits')}</h3>
            <p className="page-sub">{retentionSummary.total.toLocaleString()} {t('إيداعاً لعملاء لديهم إيداع مقبول سابقاً', 'deposits from customers with a previous approved deposit')}</p>
          </div>
          <Link to="/transactions?deposit_kind=retention" className="pay-status-link">{t('عرض الكل ←', 'View all →')}</Link>
        </div>
        <div className="retention-summary-stats">
          <div className="retention-stat paid"><strong>{retentionSummary.paid.toLocaleString()}</strong><span>{t('مدفوع', 'Paid')}</span></div>
          <div className="retention-stat declined"><strong>{retentionSummary.declined.toLocaleString()}</strong><span>{t('مرفوض', 'Declined')}</span></div>
          <div className="retention-stat pending"><strong>{retentionSummary.pending.toLocaleString()}</strong><span>{t('معلّق', 'Pending')}</span></div>
        </div>
      </section>

      {/* deposits */}
      <section className="card recent-card">
        <div className="recent-head">
          <h3>💰 {t('إيداعات معلّقة', 'Pending deposits')} {deposits && <span className="mono">({visibleDeposits.length})</span>}</h3>
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
        {deposits && visibleDeposits.length === 0 && <p>{normalizedSearch ? t('لا توجد نتائج مطابقة.', 'No matching deposits.') : t('لا توجد إيداعات معلّقة 🎉', 'No pending deposits 🎉')}</p>}
        {deposits && visibleDeposits.length > 0 && viewMode === 'table' && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {canDep && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        checked={visibleDeposits.length > 0 && visibleDeposits.every((r) => depBulk.selected.has(r.tx_id))}
                        onChange={() => depBulk.toggleAll(visibleDeposits.map((r) => r.tx_id))}
                      />
                    </th>
                  )}
                  <th>{t('الإثبات', 'Proof')}</th>
                  <th>{t('رقم العملية', 'Ref')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('العميل / المُرسِل', 'Customer / sender')}</th>
                  <th>{t('المحفظة المستلِمة', 'Receiving wallet')}</th>
                  <th>{t('SMS المرتبطة', 'Linked SMS')}</th>
                  <th>{t('نوع الإيداع', 'Deposit type')}</th>
                  <th>{t('سبب القرار', 'Decision reason')}</th>
                  <th>{t('الطريقة', 'Method')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('الوقت', 'Time')}</th>
                  <th>{t('إجراء', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleDeposits.map((r) => (
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
                    <td><SenderIdentity name={r.sender_name} phone={r.sender_number} unknown="—" />{r.sender_account_number&&r.sender_account_number!==r.sender_number&&<div className="cell-sub mono">{t('حساب المرسل','Sender account')}: {r.sender_account_number}</div>}</td>
                    <td>
                      <span className="mono">{r.receiving_wallet ?? r.to_account_number ?? '—'}</span>
                      {(r.to_account_name ?? r.to_bank) && <div className="cell-sub">{r.to_account_name ?? r.to_bank}</div>}
                    </td>
                    <td className="approval-evidence-cell">
                      {r.linked_sms ? <><span className="pay-status-badge st-paid">SMS #{r.linked_sms.id}</span><div>{r.linked_sms.sender_name ?? r.linked_sms.sender_number ?? '—'}</div><div className="cell-sub mono">{money(r.linked_sms.amount, 'EGP')} · {r.linked_sms.receiver_number ?? '—'}</div><div className="cell-sub approval-sms-line">{r.linked_sms.sms_first_line ?? '—'}</div></> : <span className="pay-status-badge st-dim">{t('لا توجد SMS', 'No SMS')}</span>}
                    </td>
                    <td><DepositKindBadge kind={r.deposit_kind} count={r.previous_approved_deposits} /></td>
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
        {deposits && visibleDeposits.length > 0 && viewMode === 'cards' && (
          <div className="approval-card-grid">
            {visibleDeposits.map((r) => (
              <article className="approval-item-card" key={r.tx_id}>
                <div className="approval-card-head">
                  <div>{canDep && <input type="checkbox" aria-label={t('تحديد المعاملة', 'Select transaction')} checked={depBulk.selected.has(r.tx_id)} onChange={() => depBulk.toggle(r.tx_id)} />}<Link to={`/transactions/${encodeURIComponent(r.ontarget_ref ?? String(r.tx_id))}`} className="mono approval-card-ref">{r.ontarget_ref ?? r.tx_id}</Link></div>
                  <span className="pay-status-badge st-pending">{t('معلّقة', 'Pending')}</span>
                </div>
                <div className="approval-card-amount">{money(r.amount, r.currency)}</div>
                  <div className="approval-card-party"><SenderIdentity name={r.sender_name} phone={r.sender_number} unknown={t('مرسل غير معروف', 'Unknown sender')} /><DepositKindBadge kind={r.deposit_kind} count={r.previous_approved_deposits} />{r.sender_account_number&&r.sender_account_number!==r.sender_number&&<small className="mono">{t('حساب المرسل','Sender account')}: {r.sender_account_number}</small>}</div>
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
                <div className="approval-card-history" aria-label={t('سجل العميل والمحفظة', 'Client and wallet history')}>
                  <span>{t('العميل', 'Client')} <b className="paid">{r.client_status_counts?.paid ?? 0}</b> / <b className="declined">{r.client_status_counts?.declined ?? 0}</b> / <b className="pending">{r.client_status_counts?.pending ?? 0}</b></span>
                  <span>{t('المحفظة', 'Wallet')} <b className="paid">{r.wallet_status_counts?.paid ?? 0}</b> / <b className="declined">{r.wallet_status_counts?.declined ?? 0}</b> / <b className="pending">{r.wallet_status_counts?.pending ?? 0}</b></span>
                  <small>{t('Paid / Declined / Pending', 'Paid / Declined / Pending')}</small>
                </div>
                <AutomationCountdown row={r} now={now} />
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
          <h3>📤 {t('سحوبات معلّقة', 'Pending payouts')} {payouts && <span className="mono">({visiblePayouts.length})</span>}</h3>
          <Link to="/payouts?status=PENDING" className="pay-status-link">{t('فتح صفحة السحوبات ←', 'Open payouts page →')}</Link>
        </div>
        <p className="drawer-note">{t('تسجيل قرارات السحب يتم من صفحة السحوبات فقط، حيث يلزم رفع إثبات للمقبول ويظهر بوضوح أن تنفيذ المزود يدوي.', 'Payout decisions are recorded from the payouts page only, where a proof upload is required for approvals and provider execution is clearly manual.')}</p>
        {!payouts && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {payouts && visiblePayouts.length === 0 && <p>{normalizedSearch ? t('لا توجد نتائج مطابقة.', 'No matching payouts.') : t('لا توجد سحوبات معلّقة 🎉', 'No pending payouts 🎉')}</p>}
        {payouts && visiblePayouts.length > 0 && viewMode === 'table' && (
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
                {visiblePayouts.map((r) => (
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
        {payouts && visiblePayouts.length > 0 && viewMode === 'cards' && (
          <div className="approval-card-grid payout-card-grid">
            {visiblePayouts.map((r) => <article className="approval-item-card" key={r.maven_id}>
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
