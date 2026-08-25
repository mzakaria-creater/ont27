import { useCallback, useEffect, useState } from 'react'
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
import { LayoutGrid, Search, TableProperties } from 'lucide-react'

// All transactions — deposits + payouts merged, sorted by our ref.

const STATUS_FILTERS = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'UNDERPAID']

interface TxRow {
  kind: 'deposit' | 'payout'
  tx_id?: number
  maven_id?: number
  ontarget_ref: string | null
  merchant_tx_reference?: string | null
  status: string
  amount: number | null
  currency?: string | null
  sender_name?: string | null
  sender_number?: string | null
  sender_account_number?: string | null
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

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const search = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
    if (type) search.set('type', type)
    if (status) search.set('status', status)
    if (appliedQ) search.set('q', appliedQ)
    for (const [key, value] of Object.entries({ from, to, merchant, method, currency, min_amount: minAmount, max_amount: maxAmount })) if (value) search.set(key, value)
    try {
      const next = await api<ListResponse>(`/api/transactions?${search}`)
      setData((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض المعاملات.', 'You do not have permission to view transactions.') : t('تعذّر تحميل المعاملات.', 'Failed to load transactions.'))
    } finally {
      setLoading(false)
    }
  }, [type, status, appliedQ, page, pageSize, from, to, merchant, method, currency, minAmount, maxAmount])

  useEffect(() => { void load() }, [load])

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
      await load()
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
        <form className="search-row transaction-search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}>
          <Search size={16} aria-hidden="true" />
          <input className="login-input search-input" placeholder={t('بحث: مرجع / اسم / موبايل / تاجر…', 'Search: ref / name / phone / merchant…')} value={q} onChange={(e) => setQ(e.target.value)} />
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

      <section className="card recent-card">
        {loading && !data && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {data && data.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {data && data.rows.length > 0 && view === 'table' && (
          <div className="table-wrap">
            <table className="data-table all-transactions-table">
              <thead>
                <tr>
                  <th>{t('رقم العملية', 'Ref')}</th>
                  <th>{t('النوع', 'Type')}</th>
                  <th>{t('الإثبات', 'Proof')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('الطرف', 'Party')}</th>
                  <th>{t('حساب المرسل', 'Sender account')}</th>
                  <th>{t('المحفظة', 'Wallet')}</th>
                  <th>{t('التكرار', 'Duplicates')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('الطريقة', 'Method')}</th>
                  <th>{t('الحالة', 'Status')}</th>
                  <th>{t('اعتمد بواسطة', 'Approved by')}</th>
                  <th>{t('الوقت', 'Time')}</th>
                  <th>{t('إجراء', 'Action')}</th>
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
                  return (
                    <tr key={`${r.kind}-${id}`} className={r.status === 'PENDING' ? 'row-pending' : undefined}>
                      <td className="mono">
                        <Link className="transaction-cell-link" to={r.kind === 'deposit' && r.ontarget_ref ? `/transactions/${encodeURIComponent(r.ontarget_ref)}` : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}>{r.ontarget_ref ?? id}</Link>
                        {r.merchant_tx_reference && <div className="cell-sub mono">{r.merchant_tx_reference}</div>}
                      </td>
                      <td>
                        <span className={`pay-status-badge ${r.kind === 'deposit' ? 'st-paid' : 'st-under'}`}>
                          {r.kind === 'deposit' ? `💰 ${t('إيداع', 'Deposit')}` : `📤 ${t('سحب', 'Payout')}`}
                        </span>
                      </td>
                      <td>{proofUrl ? <button type="button" className="proof-thumb-btn" title={t('عرض إثبات الدفع', 'View payment proof')} aria-label={t('عرض إثبات الدفع', 'View payment proof')} onClick={() => setProof({ url: proofUrl, ref: String(r.ontarget_ref ?? id) })}><img src={proofUrl} alt="" loading="lazy" /></button> : <span className="cell-sub">{t('بدون', 'None')}</span>}</td>
                      <td className="mono">{money(r.amount, r.currency ?? 'EGP')}</td>
                      <td><SenderIdentity name={party} phone={clientPhone} nameHref={party ? `/transactions?q=${encodeURIComponent(party)}` : undefined} phoneHref={clientPhone ? `/client/${encodeURIComponent(clientPhone)}` : undefined} /></td>
                      <td className="mono">{r.kind === 'deposit' ? (r.sender_account_number ?? r.sender_number ?? '—') : '—'}</td>
                      <td>{wallet ? <Link className="mono transaction-cell-link" to={`/transactions?type=deposit&q=${encodeURIComponent(wallet)}`}>{wallet}</Link> : '—'}</td>
                      <td>{(r.client_transaction_count ?? 1) > 1 ? <Link className="pay-status-badge st-under transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات','transactions')}</Link> : <span className="cell-sub">{t('أول معاملة','First')}</span>}</td>
                      <td><MerchantLogo merchant={r.merchant ?? r.master_merchant} />{r.master_merchant && r.master_merchant !== r.merchant && <div className="cell-sub">{r.master_merchant}</div>}</td>
                      <td><MethodLogo method={r.kind === 'deposit' ? r.payment_method : r.pay_by} /></td>
                      <td>
                        <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                        {r.kind === 'deposit' && r.gateway === 'NagupayP2P' && (
                          <div className={`provider-row-status ${st.cls}`} title={t('الحالة القادمة من NagoPay', 'Status received from NagoPay')}>
                            NagoPay · {r.status}
                          </div>
                        )}
                      </td>
                      <td>{r.status === 'PENDING' ? '—' : (!r.approved_by || r.approved_by === 'Manual' ? t('النظام (آلي)', 'System (auto)') : r.approved_by)}</td>
                      <td className="mono">{depositTime(r)}</td>
                      <td>
                        <div className="transaction-action-buttons">
                        {r.status === 'PENDING' && r.kind === 'deposit' && can('deposits', 'can_approve') && <>
                          <button className="btn-primary btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'approve')}>{t('اعتماد', 'Approve')}</button>
                          <button className="btn-ghost btn-sm danger" disabled={actionBusy !== null} onClick={() => void decide(r, 'decline')}>{t('رفض', 'Reject')}</button>
                        </>}
                        {r.status === 'PENDING' && r.kind === 'payout' && can('payouts', 'can_approve') && <>
                          <Link className="btn-primary btn-sm" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}>{t('رفع إثبات ودفع', 'Proof & Pay')}</Link>
                          <button className="btn-ghost btn-sm danger" disabled={actionBusy !== null} onClick={() => void decide(r, 'decline')}>{t('رفض', 'Reject')}</button>
                        </>}
                        <Link
                          className="btn-ghost btn-sm"
                          to={r.kind === 'deposit' && r.ontarget_ref
                            ? `/transactions/${encodeURIComponent(r.ontarget_ref)}`
                            : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}
                        >
                          👁 {t('تفاصيل', 'Details')}
                        </Link>
                        </div>
                      </td>
                    </tr>
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
                  <div><dt>{t('التكرار', 'Duplicates')}</dt><dd>{(r.client_transaction_count ?? 1) > 1 ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات', 'transactions')}</Link> : t('أول معاملة', 'First')}</dd></div>
                  <div><dt>{t('اعتمد بواسطة', 'Approved by')}</dt><dd>{r.status === 'PENDING' ? '—' : (!r.approved_by || r.approved_by === 'Manual' ? t('النظام (آلي)', 'System (auto)') : r.approved_by)}</dd></div>
                  <div><dt>{t('الوقت', 'Time')}</dt><dd className="mono">{depositTime(r)}</dd></div>
                </dl>
                <div className="all-tx-card-actions">
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
