import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime } from '../lib/deposits'

// Audit log viewer.

const PAGE_SIZE = 25

interface AuditRow {
  id: string
  actor_type: string | null
  actor_name: string | null
  action: string | null
  entity: string | null
  entity_id: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  ip: string | null
  created_at: string | null
}

interface ListResponse { rows: AuditRow[]; total: number }

export default function Audit() {
  const [params, setParams] = useSearchParams()
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const appliedQ = params.get('q') ?? ''
  const [data, setData] = useState<ListResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    const search = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (appliedQ) search.set('q', appliedQ)
    try {
      setData(await api<ListResponse>(`/api/audit?${search}`))
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض سجل التدقيق.' : 'تعذّر تحميل السجل.')
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
        <h2>🕵️ سجل التدقيق</h2>
        <p className="page-sub">كل إجراء على النظام موثّق{data && <> · {data.total.toLocaleString('en-US')} سجل</>}</p>
      </section>

      <div className="filter-bar">
        <form className="search-row" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}>
          <input className="login-input search-input" placeholder="بحث: إجراء / مستخدم / رقم عملية…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn-primary btn-sm">بحث</button>
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {data && data.rows.length === 0 && <p>لا توجد سجلات.</p>}
        {data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الكيان</th><th>التغيير</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="mono">{depositTime({ first_seen_at: r.created_at })}</td>
                    <td>{r.actor_name ?? r.actor_type ?? '—'}{r.ip && <div className="cell-sub mono">{r.ip}</div>}</td>
                    <td className="mono">{r.action ?? '—'}</td>
                    <td className="mono">{r.entity ?? '—'}<div className="cell-sub mono">{r.entity_id ?? ''}</div></td>
                    <td className="mono small">
                      {open === r.id ? (
                        <>
                          {r.before && <div>قبل: {JSON.stringify(r.before)}</div>}
                          {r.after && <div>بعد: {JSON.stringify(r.after)}</div>}
                        </>
                      ) : (
                        <span className="cell-sub">{r.after ? JSON.stringify(r.after).slice(0, 40) + '…' : '—'}</span>
                      )}
                    </td>
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
