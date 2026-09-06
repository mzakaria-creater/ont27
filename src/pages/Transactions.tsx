import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import MerchantLogo from '../components/MerchantLogo'
import MethodLogo from '../components/MethodLogo'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'
import ProofModal from '../components/ProofModal'
import SenderIdentity from '../components/SenderIdentity'
import { useAuth } from '../auth/AuthContext'
import { ChevronDown, ChevronRight, Eye, Image, LayoutGrid, Pencil, Search, TableProperties, X } from 'lucide-react'
import TransactionEditDialog from '../components/TransactionEditDialog'
import { supabase } from '../lib/supabase'
import { syncProviders } from '../lib/providerSync'

// All transactions — deposits + payouts merged, sorted by our ref.

const STATUS_FILTERS = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'UNDERPAID']

interface TxRow {
  kind: 'deposit' | 'payout'
  tx_id?: number
  maven_id?: number
  ontarget_ref: string | null
  merchant_tx_reference?: string | null
  merchant_reference?: string | null
  status: string
  amount: number | null
  currency?: string | null
  sender_name?: string | null
  sender_number?: string | null
  sender_account_number?: string | null
  sender_account_name?: string | null
  user_email?: string | null
  account_name?: string | null
  mobile_no?: string | null
  payment_method?: string | null
  pay_by?: string | null
  gateway?: string | null
  receiving_wallet?: string | null
  to_account_number?: string | null
  merchant: string | null
  master_merchant?: string | null
  proof_image_url?: string | null
  image_url?: string | null
  approved_by: string | null
  first_seen_at: string | null
  created_utc: string | null
  client_transaction_count?: number
  deposit_kind?: 'first_deposit' | 'retention_deposit' | null
  previous_approved_deposits?: number
  matched_sms?: { id: number; received_at: string | null; amount: number | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; device_name: string | null; sms_first_line: string | null; raw_sms: string | null; raw_payload?: Record<string, unknown> | null; message: string | null; sms_category: string | null; match_status: string | null; matched: boolean | null } | null
  raw_preview?: Record<string, unknown> | null
}

interface ListResponse {
  rows: TxRow[]
  total: number
}

export default function Transactions() {
  const [pageSize, setPageSize] = usePageSize('transactions')
  const { t } = useLocale()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const type = params.get('type') ?? ''
  const status = params.get('status') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const merchant = params.get('merchant') ?? ''
  const method = params.get('method') ?? ''
  const currency = params.get('currency') ?? ''
  const minAmount = params.get('min_amount') ?? ''
  const maxAmount = params.get('max_amount') ?? ''
  const view = params.get('view') === 'cards' ? 'cards' : 'table'
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const appliedQ = params.get('q') ?? ''
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [proof, setProof] = useState<{ url: string; ref: string } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  useEffect(() => setQ(appliedQ), [appliedQ])

  const refreshTimer = useRef<number | null>(null)
  const requestSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const load = useCallback(async (silent = false) => {
    const seq = ++requestSeq.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (!silent) setLoading(true)
    setErr(null)
    const search = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
    if (type) search.set('type', type)
    if (status) search.set('status', status)
    if (appliedQ) search.set('q', appliedQ)
    for (const [key, value] of Object.entries({ from, to, merchant, method, currency, min_amount: minAmount, max_amount: maxAmount })) if (value) search.set(key, value)
    try {
      const next = await api<ListResponse>(`/api/transactions?${search}`, { signal: controller.signal })
      if (seq !== requestSeq.current) return
      setData((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    } catch (e) {
      if (controller.signal.aborted) return
      if (seq !== requestSeq.current) return
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض المعاملات.', 'You do not have permission to view transactions.') : t('تعذّر تحميل المعاملات.', 'Failed to load transactions.'))
    } finally {
      setLoading(false)
    }
  }, [type, status, appliedQ, page, pageSize, from, to, merchant, method, currency, minAmount, maxAmount])

  useEffect(() => { void load() }, [load])

  // Keep All Transactions live as well as the approval queue. Provider pulls
  // are shared across tabs and local realtime events repaint immediately once
  // the delta has landed, without flashing the existing table.
  useEffect(() => {
    const schedule = () => {
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; void load(true) }, 120)
    }
    const channel = supabase.channel('transactions-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maven_transactions' }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'maven_payout_transactions' }, schedule)
      .subscribe()
    const syncIv = window.setInterval(() => { void syncProviders().then((changed) => { if (changed) schedule() }) }, 30_000)
    return () => {
      abortRef.current?.abort()
      window.clearInterval(syncIv)
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
      void supabase.removeChannel(channel)
    }
  }, [load])

  // Status summary counts (respects the deposit/payout filter, ignores search).
  useEffect(() => {
    const qp = type ? `?type=${type}` : ''
    api<{ counts: { status: string; count: number }[] }>(`/api/transactions/status-counts${qp}`)
      .then((r) => setCounts(Object.fromEntries(r.counts.map((c) => [c.status, c.count]))))
      .catch(() => setCounts({}))
  }, [type])

  const setFilter = (next: { type?: string; status?: string; q?: string; page?: number; from?: string; to?: string; merchant?: string; method?: string; currency?: string; min_amount?: string; max_amount?: string; view?: string }) => {
    const p = new URLSearchParams(params)
    const put = (k: string, v: string | undefined) => {
      if (v === undefined) return
      if (v) p.set(k, v); else p.delete(k)
      p.delete('page')
    }
    put('type', next.type)
    put('status', next.status)
    put('q', next.q)
    put('view', next.view)
    put('from', next.from); put('to', next.to); put('merchant', next.merchant); put('method', next.method); put('currency', next.currency); put('min_amount', next.min_amount); put('max_amount', next.max_amount)
    if (next.page !== undefined) {
      if (next.page > 1) p.set('page', String(next.page)); else p.delete('page')
    }
    setParams(p)
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1
  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const decide = async (row: TxRow, action: 'approve' | 'decline') => {
    const id = row.kind === 'deposit' ? row.tx_id : row.maven_id
    if (!id) return
    if (!window.confirm(action === 'approve' ? t('تأكيد اعتماد المعاملة؟', 'Approve this transaction?') : t('تأكيد رفض المعاملة؟', 'Reject this transaction?'))) return
    const key = `${row.kind}-${id}-${action}`
    setActionBusy(key)
    setErr(null)
    try {
      if (row.kind === 'deposit') {
        await api(`/api/deposits/${id}/decision`, { method: 'POST', body: JSON.stringify({ action, note: `Decision from All Transactions: ${action}` }) })
      } else if (action === 'decline') {
        await api(`/api/payouts/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'DECLINED', remark: 'Declined from All Transactions', mode: 'auto' }) })
      }
      await load(true)
    } catch (e) {
      setErr(e instanceof ApiError ? `${t('فشل تنفيذ القرار', 'Decision failed')}: ${e.code}` : t('فشل تنفيذ القرار.', 'Decision failed.'))
    } finally {
      setActionBusy(null)
    }
  }

  return (
    <PanelShell>
      <section className="page-head all-transactions-head">
        <div><h2>📋 {t('كل المعاملات', 'All transactions')}</h2>
        <p className="page-sub">{t('إيداعات وسحوبات موحّدة', 'Deposits and payouts unified')}{data && <> · {data.total.toLocaleString('en-US')}</>}</p></div>
        <div className="view-switch" role="group" aria-label={t('طريقة العرض', 'View mode')}>
          <button className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setFilter({ view: 'table' })}><TableProperties size={16} />{t('جدول', 'Table')}</button>
          <button className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => setFilter({ view: 'cards' })}><LayoutGrid size={16} />{t('بطاقات', 'Cards')}</button>
        </div>
      </section>

      <div className="filter-bar transaction-filter-toolbar">
        <div className="filter-pills">
          <button className={`pill${type === '' ? ' active' : ''}`} onClick={() => setFilter({ type: '' })}>{t('الكل', 'All')}</button>
          <button className={`pill${type === 'deposit' ? ' active' : ''}`} onClick={() => setFilter({ type: 'deposit' })}>💰 {t('إيداعات', 'Deposits')}</button>
          <button className={`pill${type === 'payout' ? ' active' : ''}`} onClick={() => setFilter({ type: 'payout' })}>📤 {t('سحوبات', 'Payouts')}</button>
        </div>
        <div className="chip-row">
          <button className={`chip${status === '' ? ' chip-active' : ''}`} onClick={() => setFilter({ status: '' })}>
            {t('الكل', 'All')}{Object.keys(counts).length > 0 && <span className="chip-count">{Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString('en-US')}</span>}
          </button>
          {STATUS_FILTERS.map((s) => (
            <button key={s} className={`chip status-chip st-${statusMeta(s).cls.replace('st-', '')}${status === s ? ' chip-active' : ''}`} onClick={() => setFilter({ status: status === s ? '' : s })}>
              <span className={`dot-${statusMeta(s).cls}`} />{statusMeta(s).label}
              {counts[s] != null && <span className="chip-count">{counts[s].toLocaleString('en-US')}</span>}
            </button>
          ))}
        </div>
        <form className="search-row transaction-search-row trx-search-bar" role="search" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}>
          <Search size={16} aria-hidden="true" />
          <input type="search" className="login-input search-input" aria-label={t('بحث المعاملات', 'Search transactions')} placeholder={t('بحث: مبلغ / مرسل / رقم عملية / مرجع تاجر / مستخدم…', 'Search: amount / sender / transaction / merchant ref / user…')} value={q} onChange={(e) => setQ(e.target.value)} />
          {(q || appliedQ) && <button type="button" className="trx-search-clear" onClick={() => { setQ(''); setFilter({ q: '' }) }} aria-label={t('مسح البحث', 'Clear search')}><X size={15}/></button>}
          <button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>
        </form>
        <div className="transaction-filter-fields">
          <label className="filter-field">{t('من', 'From')}<input className="login-input" type="date" value={from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
          <label className="filter-field">{t('إلى', 'To')}<input className="login-input" type="date" value={to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
          <label className="filter-field">{t('التاجر', 'Merchant')}<input className="login-input" value={merchant} onChange={(e) => setFilter({ merchant: e.target.value })} /></label>
          <label className="filter-field">{t('الطريقة', 'Method')}<input className="login-input" value={method} onChange={(e) => setFilter({ method: e.target.value })} /></label>
          <label className="filter-field">{t('العملة', 'Currency')}<select className="login-input" value={currency} onChange={(e) => setFilter({ currency: e.target.value })}><option value="">{t('الكل', 'All')}</option><option value="EGP">EGP</option><option value="USD">USD</option><option value="USDT">USDT</option></select></label>
          <label className="filter-field">{t('أدنى مبلغ', 'Min amount')}<input className="login-input" type="number" min="0" value={minAmount} onChange={(e) => setFilter({ min_amount: e.target.value })} /></label>
          <label className="filter-field">{t('أقصى مبلغ', 'Max amount')}<input className="login-input" type="number" min="0" value={maxAmount} onChange={(e) => setFilter({ max_amount: e.target.value })} /></label>
          <button className="btn-ghost btn-sm" onClick={() => setFilter({ from: '', to: '', merchant: '', method: '', currency: '', min_amount: '', max_amount: '', status: '', type: '', q: '' })}>{t('مسح الفلاتر', 'Clear filters')}</button>
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card portal-transactions-card">
        {loading && !data && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {data && data.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {data && data.rows.length > 0 && view === 'table' && (
          <div className="table-wrap portal-table-wrap">
            <table className="data-table all-transactions-table portal-transaction-grid">
              <thead>
                <tr>
                  <th aria-label={t('توسيع', 'Expand')} />
                  <th>{t('الإجراء', 'Action')}</th>
                  <th>{t('رقم المعاملة', 'Transaction ID')}</th>
                  <th>{t('الحالة', 'Status')}</th>
                  <th>{t('نوع الدفع', 'Payment Type')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('بريد المستخدم', 'User Email')}</th>
                  <th>{t('هاتف المستخدم', 'User Phone Number')}</th>
                  <th>{t('اسم حساب المرسل', 'Sender Account Name')}</th>
                  <th>{t('رقم حساب المرسل', 'Sender Account Number')}</th>
                  <th>{t('تاريخ الإنشاء UTC', 'Created UTC Date')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = statusMeta(r.status)
                  const id = r.kind === 'deposit' ? r.tx_id : r.maven_id
                  const party = r.kind === 'deposit' ? (r.sender_name ?? r.sender_number) : (r.account_name ?? r.mobile_no)
                  const clientPhone = r.kind === 'deposit' ? r.sender_number : r.mobile_no
                  const wallet = r.kind === 'deposit' ? (r.receiving_wallet ?? r.to_account_number) : null
                  const proofUrl = r.kind === 'deposit' ? r.proof_image_url : r.image_url
                  const rowKey = `${r.kind}-${id}`
                  const isExpanded = expanded.has(rowKey)
                  const details = r.kind === 'deposit' && r.ontarget_ref ? `/transactions/${encodeURIComponent(r.ontarget_ref)}` : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`
                  const senderAccountName = r.kind === 'deposit' ? (r.sender_account_name ?? r.payment_method ?? party) : (r.account_name ?? party)
                  return (
                    <Fragment key={rowKey}>
                      {r.kind === 'deposit' && (r.matched_sms ? <tr className={`tx-sms-raw-row tx-sms-above tx-pair-${Math.abs(Number(id ?? 0)) % 5}`}><td colSpan={11}><div className="tx-sms-raw"><span className="tx-sms-label">📨 SMS الخاص بالمعاملة</span><span className="mono">#{r.matched_sms.id}</span><span>{r.matched_sms.sender_name ?? r.matched_sms.sender_number ?? '—'} → {r.matched_sms.receiver_number ?? '—'}</span><span className="mono">{money(r.matched_sms.amount, r.currency ?? 'EGP')}</span><code>{r.matched_sms.raw_sms ?? r.matched_sms.message ?? r.matched_sms.sms_first_line ?? '—'}</code></div></td></tr> : <tr className="tx-sms-raw-row tx-sms-missing"><td colSpan={11}><div className="tx-sms-raw"><span className="tx-sms-label">⚠️ SMS</span><strong>{t('لا توجد رسالة SMS مرتبطة', 'No SMS linked')}</strong><Link to={`/sms?amount=${r.amount ?? ''}`}>{t('البحث عن رسالة', 'Search SMS')}</Link></div></td></tr>)}
                      <tr key={rowKey} className={`${r.status === 'PENDING' ? 'row-pending ' : ''}${r.matched_sms ? `tx-pair-${Math.abs(Number(id ?? 0)) % 5}` : ''}`}>
                        <td><button type="button" className="tx-expand-btn" onClick={() => toggleExpanded(rowKey)} aria-expanded={isExpanded} aria-label={isExpanded ? t('إغلاق التفاصيل', 'Collapse details') : t('فتح التفاصيل', 'Expand details')}>{isExpanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button></td>
                        <td><div className="portal-row-actions"><Link className="tx-action-primary" to={details}>{r.status === 'PENDING' ? <Pencil size={13}/> : <Eye size={13}/>}<span>{r.status === 'PENDING' ? t('تعديل', 'Edit') : t('عرض', 'View')}</span></Link>{id && <TransactionEditDialog txId={Number(id)} ontargetRef={r.ontarget_ref} status={r.status} amount={r.amount} currency={r.currency} gateway={r.gateway} onDone={() => void load()} />}{proofUrl && <button type="button" className="tx-proof-icon" onClick={() => setProof({ url: proofUrl, ref: String(r.ontarget_ref ?? id) })} aria-label={t('عرض الإثبات', 'View proof')} title={t('عرض الإثبات', 'View proof')}><Image size={15}/></button>}</div></td>
                        <td className="mono"><Link className="transaction-cell-link" to={details}>{id}</Link>{r.ontarget_ref && String(r.ontarget_ref) !== String(id) && <div className="cell-sub mono">{r.ontarget_ref}</div>}{(r.merchant_reference ?? r.merchant_tx_reference) && <div className="cell-sub mono" title="NGPay merchant reference">{r.merchant_reference ?? r.merchant_tx_reference}</div>}{r.kind === 'deposit' && <span className={`deposit-kind ${r.deposit_kind === 'retention_deposit' ? 'is-retention' : 'is-first'}`}>{r.deposit_kind === 'retention_deposit' ? `↻ ${t('Retention','Retention')}` : `★ ${t('First','First')}`}</span>}</td>
                        <td><span className={`portal-status-tag ${st.cls}`}>{st.label}</span></td>
                        <td><div className="portal-method-cell"><MethodLogo method={r.kind === 'deposit' ? r.payment_method : r.pay_by}/><span>{r.kind === 'deposit' ? (r.payment_method ?? t('إيداع', 'Deposit')) : (r.pay_by ?? t('سحب', 'Payout'))}</span></div></td>
                        <td className="mono portal-amount-cell">{money(r.amount, r.currency ?? 'EGP')}</td>
                        <td>{r.user_email ? <a href={`mailto:${r.user_email}`} className="transaction-cell-link">{r.user_email}</a> : '—'}</td>
                        <td><SenderIdentity name={null} phone={clientPhone} phoneHref={clientPhone ? `/client/${encodeURIComponent(clientPhone)}` : undefined}/></td>
                        <td>{senderAccountName ?? '—'}</td>
                        <td className="mono"><Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(r.sender_account_number ?? clientPhone ?? '')}`}>{r.sender_account_number ?? clientPhone ?? '—'}</Link></td>
                        <td className="mono">{depositTime(r)}</td>
                      </tr>
                      {isExpanded && <tr key={`${rowKey}-details`} className="tx-expanded-row"><td colSpan={11}><div className="tx-expanded-grid">
                        <div><span>{t('الطرف', 'Party')}</span><SenderIdentity name={party} phone={clientPhone} nameHref={party ? `/transactions?q=${encodeURIComponent(party)}` : undefined} phoneHref={clientPhone ? `/client/${encodeURIComponent(clientPhone)}` : undefined}/></div>
                        <div><span>{t('المحفظة المستلمة', 'Receiving wallet')}</span>{wallet ? <Link className="mono transaction-cell-link" to={`/transactions?type=deposit&q=${encodeURIComponent(wallet)}`}>{wallet}</Link> : '—'}</div>
                        <div><span>{t('التاجر', 'Merchant')}</span><MerchantLogo merchant={r.merchant ?? r.master_merchant}/></div>
                        <div><span>{t('البوابة', 'Gateway')}</span><strong>{r.gateway ?? '—'}</strong></div>
                        <div><span>{t('التكرار', 'Duplicates')}</span>{(r.client_transaction_count ?? 1) > 1 ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات', 'transactions')}</Link> : t('أول معاملة', 'First transaction')}</div>
                        <div><span>{t('اعتمد بواسطة', 'Approved by')}</span><strong>{r.status === 'PENDING' ? '—' : (!r.approved_by || r.approved_by === 'Manual' ? t('النظام (آلي)', 'System (auto)') : r.approved_by)}</strong></div>
                        <div className="tx-expanded-actions">{r.status === 'PENDING' && r.kind === 'deposit' && can('deposits','can_approve') && <><button className="btn-primary btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r,'approve')}>{t('اعتماد', 'Approve')}</button><button className="btn-ghost btn-sm danger" disabled={actionBusy !== null} onClick={() => void decide(r,'decline')}>{t('رفض', 'Reject')}</button></>}{r.status === 'PENDING' && r.kind === 'payout' && can('payouts','can_approve') && <><Link className="btn-primary btn-sm" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}>{t('إثبات ودفع', 'Proof & Pay')}</Link><button className="btn-ghost btn-sm danger" disabled={actionBusy !== null} onClick={() => void decide(r,'decline')}>{t('رفض', 'Reject')}</button></>}</div>
                        {r.kind === 'deposit' && r.raw_preview && <details className="tx-raw-details"><summary>{t('عرض Raw المعاملة', 'View transaction raw')}</summary><pre>{JSON.stringify(r.raw_preview, null, 2)}</pre></details>}
                      </div></td></tr>}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.rows.length > 0 && view === 'cards' && (
          <div className="all-tx-card-grid">
            {data.rows.map((r) => {
              const st = statusMeta(r.status)
              const id = r.kind === 'deposit' ? r.tx_id : r.maven_id
              const party = r.kind === 'deposit' ? (r.sender_name ?? r.sender_number) : (r.account_name ?? r.mobile_no)
              const clientPhone = r.kind === 'deposit' ? r.sender_number : r.mobile_no
              const wallet = r.kind === 'deposit' ? (r.receiving_wallet ?? r.to_account_number) : null
              const proofUrl = r.kind === 'deposit' ? r.proof_image_url : r.image_url
              const details = r.kind === 'deposit' && r.ontarget_ref ? `/transactions/${encodeURIComponent(r.ontarget_ref)}` : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`
              return <article key={`${r.kind}-${id}`} className={`all-tx-card${r.status === 'PENDING' ? ' pending' : ''}`}>
                <header><Link className="mono transaction-cell-link" to={details}>{r.ontarget_ref ?? id}</Link><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></header>
                <div className="all-tx-card-amount mono">{money(r.amount, r.currency ?? 'EGP')}</div>
                {proofUrl && <button type="button" className="all-tx-card-proof" onClick={() => setProof({ url: proofUrl, ref: String(r.ontarget_ref ?? id) })}><img src={proofUrl} alt="" loading="lazy" /><span>{t('عرض إثبات الدفع', 'View payment proof')}</span></button>}
                <div className="all-tx-card-brands"><MerchantLogo merchant={r.merchant ?? r.master_merchant} /><MethodLogo method={r.kind === 'deposit' ? r.payment_method : r.pay_by} /></div>
                <dl>
                  <div><dt>{t('النوع', 'Type')}</dt><dd>{r.kind === 'deposit' ? t('إيداع', 'Deposit') : t('سحب', 'Payout')}</dd></div>
                  <div><dt>{t('الطرف', 'Party')}</dt><dd><SenderIdentity name={party} phone={clientPhone} nameHref={party ? `/transactions?q=${encodeURIComponent(party)}` : undefined} phoneHref={clientPhone ? `/client/${encodeURIComponent(clientPhone)}` : undefined} /></dd></div>
                  <div><dt>{t('حساب المرسل', 'Sender account')}</dt><dd className="mono">{r.kind === 'deposit' ? (r.sender_account_number ?? r.sender_number ?? '—') : '—'}</dd></div>
                  <div><dt>{t('المحفظة', 'Wallet')}</dt><dd className="mono">{wallet ?? '—'}</dd></div>
                  <div><dt>{t('نوع الإيداع', 'Deposit type')}</dt><dd>{r.kind === 'deposit' ? <span className={`deposit-kind ${r.deposit_kind === 'retention_deposit' ? 'is-retention' : 'is-first'}`}>{r.deposit_kind === 'retention_deposit' ? `↻ ${t('Retention deposit','Retention deposit')}` : `★ ${t('First deposit','First deposit')}`}</span> : '—'}</dd></div>
                  <div><dt>{t('التكرار', 'Duplicates')}</dt><dd>{(r.client_transaction_count ?? 1) > 1 ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات', 'transactions')}</Link> : t('أول معاملة', 'First')}</dd></div>
                  <div><dt>{t('اعتمد بواسطة', 'Approved by')}</dt><dd>{r.status === 'PENDING' ? '—' : (!r.approved_by || r.approved_by === 'Manual' ? t('النظام (آلي)', 'System (auto)') : r.approved_by)}</dd></div>
                  <div><dt>{t('الوقت', 'Time')}</dt><dd className="mono">{depositTime(r)}</dd></div>
                </dl>
                <div className="all-tx-card-actions">
                  {id && <TransactionEditDialog txId={Number(id)} ontargetRef={r.ontarget_ref} status={r.status} amount={r.amount} currency={r.currency} gateway={r.gateway} onDone={() => void load()} />}
                  {r.status === 'PENDING' && r.kind === 'deposit' && can('deposits', 'can_approve') && <><button className="btn-primary btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'approve')}>{t('اعتماد', 'Approve')}</button><button className="btn-ghost danger btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'decline')}>{t('رفض', 'Reject')}</button></>}
                  {r.status === 'PENDING' && r.kind === 'payout' && can('payouts', 'can_approve') && <><Link className="btn-primary btn-sm" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}>{t('إثبات ودفع', 'Proof & Pay')}</Link><button className="btn-ghost danger btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'decline')}>{t('رفض', 'Reject')}</button></>}
                  <Link className="btn-ghost btn-sm" to={details}>{t('التفاصيل', 'Details')}</Link>
                </div>
              </article>
            })}
          </div>
        )}
        {data && totalPages > 1 && (
          <div className="pager">
            <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>→ {t('السابق', 'Prev')}</button>
            <PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setFilter({ page: 1 }) }} />
            <span className="pager-info mono">{page} / {totalPages}</span>
            <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>{t('التالي', 'Next')} ←</button>
          </div>
        )}
      </section>
      {proof && <ProofModal url={proof.url} title={`${t('إثبات الدفع', 'Payment proof')} · ${proof.ref}`} onClose={() => setProof(null)} />}
    </PanelShell>
  )
}
