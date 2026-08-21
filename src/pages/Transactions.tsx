import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'

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
  account_name?: string | null
  mobile_no?: string | null
  payment_method?: string | null
  pay_by?: string | null
  gateway?: string | null
  merchant: string | null
  master_merchant?: string | null
  approved_by: string | null
  first_seen_at: string | null
  created_utc: string | null
}

interface ListResponse {
  rows: TxRow[]
  total: number
}

export default function Transactions() {
  const [pageSize, setPageSize] = usePageSize('transactions')
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const type = params.get('type') ?? ''
  const status = params.get('status') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const appliedQ = params.get('q') ?? ''
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const search = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) })
    if (type) search.set('type', type)
    if (status) search.set('status', status)
    if (appliedQ) search.set('q', appliedQ)
    try {
      setData(await api<ListResponse>(`/api/transactions?${search}`))
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض المعاملات.', 'You do not have permission to view transactions.') : t('تعذّر تحميل المعاملات.', 'Failed to load transactions.'))
    } finally {
      setLoading(false)
    }
  }, [type, status, appliedQ, page, pageSize])

  useEffect(() => { void load() }, [load])

  // Status summary counts (respects the deposit/payout filter, ignores search).
  useEffect(() => {
    const qp = type ? `?type=${type}` : ''
    api<{ counts: { status: string; count: number }[] }>(`/api/transactions/status-counts${qp}`)
      .then((r) => setCounts(Object.fromEntries(r.counts.map((c) => [c.status, c.count]))))
      .catch(() => setCounts({}))
  }, [type])

  const setFilter = (next: { type?: string; status?: string; q?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    const put = (k: string, v: string | undefined) => {
      if (v === undefined) return
      if (v) p.set(k, v); else p.delete(k)
      p.delete('page')
    }
    put('type', next.type)
    put('status', next.status)
    put('q', next.q)
    if (next.page !== undefined) {
      if (next.page > 1) p.set('page', String(next.page)); else p.delete('page')
    }
    setParams(p)
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1

  return (
    <PanelShell>
      <section className="page-head">
        <h2>📋 {t('كل المعاملات', 'All transactions')}</h2>
        <p className="page-sub">{t('إيداعات وسحوبات موحّدة', 'Deposits and payouts unified')}{data && <> · {data.total.toLocaleString('en-US')}</>}</p>
      </section>

      <div className="filter-bar">
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
        <form className="search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}>
          <input className="login-input search-input" placeholder={t('بحث: مرجع / اسم / موبايل / تاجر…', 'Search: ref / name / phone / merchant…')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {loading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {!loading && data && data.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {!loading && data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('رقم العملية', 'Ref')}</th>
                  <th>{t('النوع', 'Type')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('الطرف', 'Party')}</th>
                  <th>{t('التاجر', 'Merchant')}</th>
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
                  return (
                    <tr key={`${r.kind}-${id}`} className={r.status === 'PENDING' ? 'row-pending' : undefined}>
                      <td className="mono">
                        {r.ontarget_ref ?? id}
                        {r.merchant_tx_reference && <div className="cell-sub mono">{r.merchant_tx_reference}</div>}
                      </td>
                      <td>
                        <span className={`pay-status-badge ${r.kind === 'deposit' ? 'st-paid' : 'st-under'}`}>
                          {r.kind === 'deposit' ? `💰 ${t('إيداع', 'Deposit')}` : `📤 ${t('سحب', 'Payout')}`}
                        </span>
                      </td>
                      <td className="mono">{money(r.amount, r.currency ?? 'EGP')}</td>
                      <td>{party ?? '—'}</td>
                      <td>{r.merchant ?? '—'}{r.master_merchant && <div className="cell-sub">{r.master_merchant}</div>}</td>
                      <td><span className={`pay-status-badge ${st.cls}`}>{st.label}</span></td>
                      <td>{r.status === 'PENDING' ? '—' : (!r.approved_by || r.approved_by === 'Manual' ? t('النظام (آلي)', 'System (auto)') : r.approved_by)}</td>
                      <td className="mono">{depositTime(r)}</td>
                      <td>
                        <Link
                          className="btn-ghost btn-sm"
                          to={r.kind === 'deposit' && r.ontarget_ref
                            ? `/transactions/${encodeURIComponent(r.ontarget_ref)}`
                            : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}
                        >
                          👁 {t('تفاصيل', 'Details')}
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
    </PanelShell>
  )
}