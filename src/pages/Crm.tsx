import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'

// CRM — crm_clients directory.

const PAGE_SIZE = 25

interface ClientRow {
  id: string
  client_name: string | null
  phone_no: string | null
  normalized_phone: string | null
  merchant_name: string | null
  first_transaction_at: string | null
  last_transaction_at: string | null
  total_deposit: number | null
  approved_deposit: number | null
  total_transactions: number | null
  approved_transactions: number | null
  declined_transactions: number | null
  approval_rate: number | null
  risk_score: number | null
  is_vip: boolean | null
  is_repeat_client: boolean | null
  needs_review: boolean | null
}

interface ListResponse { rows: ClientRow[]; total: number }

export default function Crm() {
  const [params, setParams] = useSearchParams()
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const appliedQ = params.get('q') ?? ''
  const [data, setData] = useState<ListResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (appliedQ) search.set('q', appliedQ)
    try {
      setData(await api<ListResponse>(`/api/crm?${search}`))
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض العملاء.' : 'تعذّر تحميل العملاء.')
    }
  }, [appliedQ, page])

  useEffect(() => { void load() }, [load])

  const setFilter = (next: { q?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    if (next.q !== undefined) {
      if (next.q) p.set('q', next.q); else p.delete('q')
      p.delete('page')
    }
    if (next.page !== undefined) {
      if (next.page > 1) p.set('page', String(next.page)); else p.delete('page')
    }
    setParams(p)
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1

  return (
    <PanelShell>
      <section className="page-head">
        <h2>👥 CRM العملاء</h2>
        <p className="page-sub">ملفات المودعين المجمّعة{data && <> · {data.total.toLocaleString('en-US')} عميل</>}</p>
      </section>

      <div className="filter-bar">
        <form className="search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}>
          <input className="login-input search-input" placeholder="بحث: اسم / رقم موبايل / تاجر…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn-primary btn-sm">بحث</button>
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {data && data.rows.length === 0 && <p>لا توجد نتائج.</p>}
        {data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>التاجر</th>
                  <th>إجمالي الإيداعات</th>
                  <th>المعاملات</th>
                  <th>نسبة القبول</th>
                  <th>الحالة</th>
                  <th>آخر معاملة</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.client_name ?? '—'}
                      <div className="cell-sub mono">{r.phone_no ?? r.normalized_phone ?? '—'}</div>
                    </td>
                    <td>{r.merchant_name ?? '—'}</td>
                    <td className="mono">
                      {money(r.approved_deposit, 'EGP')}
                      <div className="cell-sub mono">من {money(r.total_deposit, 'EGP')}</div>
                    </td>
                    <td className="mono">
                      {r.total_transactions ?? 0}
                      <div className="cell-sub mono">✓{r.approved_transactions ?? 0} · ✗{r.declined_transactions ?? 0}</div>
                    </td>
                    <td className="mono">{r.approval_rate != null ? `${Math.round(Number(r.approval_rate))}%` : '—'}</td>
                    <td>
                      {r.is_vip && <span className="pay-status-badge st-paid">VIP</span>}{' '}
                      {r.needs_review && <span className="pay-status-badge st-pending">مراجعة</span>}{' '}
                      {r.risk_score != null && Number(r.risk_score) > 0 && (
                        <span className="pay-status-badge st-declined">خطورة {r.risk_score}</span>
                      )}
                      {!r.is_vip && !r.needs_review && (r.risk_score == null || Number(r.risk_score) === 0) && (
                        <span className="pay-status-badge st-dim">عادي</span>
                      )}
                    </td>
                    <td className="mono">{depositTime({ first_seen_at: r.last_transaction_at })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && totalPages > 1 && (
          <div className="pager">
            <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>→ السابق</button>
            <span className="pager-info mono">{page} / {totalPages}</span>
            <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>التالي ←</button>
          </div>
        )}
      </section>
    </PanelShell>
  )
}
