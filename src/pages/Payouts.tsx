import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useBulk } from '../lib/useBulk'
import { depositTime, money, statusMeta } from '../lib/deposits'

const PAGE_SIZE = 25
const STATUS_FILTERS = ['PENDING', 'APPROVED', 'DECLINED']

// maven_payout_transactions has no currency column — payouts are EGP.
const CURRENCY = 'EGP'

export interface PayoutRow {
  maven_id: number
  guid: string | null
  ontarget_ref: string | null
  status: string
  amount: number | null
  pay_by: string | null
  merchant: string | null
  account_name: string | null
  mobile_no: string | null
  agent_name: string | null
  approved_by: string | null
  commission: number | null
  remark: string | null
  image_url: string | null
  created_utc: string | null
  first_seen_at: string | null
  last_seen_at: string | null
}

interface PayoutDetail extends PayoutRow {
  matched_sms_id: number | null
  updated_utc: string | null
}

interface ListResponse {
  rows: PayoutRow[]
  total: number
  limit: number
  offset: number
}

export default function Payouts() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<PayoutDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionErr, setDecisionErr] = useState<string | null>(null)

  const appliedQ = params.get('q') ?? ''

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const search = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    })
    if (status) search.set('status', status)
    if (appliedQ) search.set('q', appliedQ)
    try {
      setData(await api<ListResponse>(`/api/payouts?${search}`))
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض السحوبات.' : 'تعذّر تحميل السحوبات.')
    } finally {
      setLoading(false)
    }
  }, [status, appliedQ, page])

  useEffect(() => { void load() }, [load])

  const setFilter = (next: { status?: string; q?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    if (next.status !== undefined) {
      if (next.status) p.set('status', next.status); else p.delete('status')
      p.delete('page')
    }
    if (next.q !== undefined) {
      if (next.q) p.set('q', next.q); else p.delete('q')
      p.delete('page')
    }
    if (next.page !== undefined) {
      if (next.page > 1) p.set('page', String(next.page)); else p.delete('page')
    }
    setParams(p)
  }

  const openDetail = async (mavenId: number) => {
    setDetailLoading(true)
    setDecisionErr(null)
    try {
      const res = await api<{ payout: PayoutDetail }>(`/api/payouts/${mavenId}`)
      setSelected(res.payout)
    } catch {
      setErr('تعذّر تحميل تفاصيل السحب.')
    } finally {
      setDetailLoading(false)
    }
  }

  const [rowBusy, setRowBusy] = useState<number | null>(null)
  const bulk = useBulk((id) => `/api/payouts/${id}/decision`, () => void load())

  const quickDecide = async (mavenId: number, action: 'approve' | 'decline') => {
    setRowBusy(mavenId)
    setErr(null)
    try {
      await api(`/api/payouts/${mavenId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') {
        setErr('حالة السحب اتغيّرت بالفعل — أعد التحميل.')
        void load()
      } else if (e instanceof ApiError && e.status === 403) {
        setErr('لا تملك صلاحية الاعتماد (can_approve غير ممنوحة لدورك).')
      } else {
        setErr('فشل تنفيذ القرار — حاول مرة أخرى.')
      }
    } finally {
      setRowBusy(null)
    }
  }

  const decide = async (action: 'approve' | 'decline') => {
    if (!selected) return
    setDecisionBusy(true)
    setDecisionErr(null)
    try {
      await api(`/api/payouts/${selected.maven_id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      setSelected(null)
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') {
        setDecisionErr('حالة السحب اتغيّرت بالفعل — أعد التحميل.')
      } else if (e instanceof ApiError && e.status === 403) {
        setDecisionErr('لا تملك صلاحية الاعتماد (can_approve غير ممنوحة لدورك).')
      } else {
        setDecisionErr('فشل تنفيذ القرار — حاول مرة أخرى.')
      }
    } finally {
      setDecisionBusy(false)
    }
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1

  return (
    <PanelShell>
      <section className="page-head">
        <h2>📤 السحوبات</h2>
        <p className="page-sub">
          مصدر الحقيقة: <span className="mono">maven_payout_transactions</span>
          {data && <> · {data.total.toLocaleString('en-US')} نتيجة</>}
        </p>
      </section>

      <div className="filter-bar">
        <div className="chip-row">
          <button
            className={`chip${status === '' ? ' chip-active' : ''}`}
            onClick={() => setFilter({ status: '' })}
          >
            الكل
          </button>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={`chip${status === s ? ' chip-active' : ''}`}
              onClick={() => setFilter({ status: s })}
            >
              {statusMeta(s).label}
            </button>
          ))}
        </div>
        <form
          className="search-row"
          onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}
        >
          <input
            className="login-input search-input"
            placeholder="بحث: مرجع / موبايل / اسم حساب / تاجر / رقم Maven…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="btn-primary btn-sm">بحث</button>
          {appliedQ && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => { setQ(''); setFilter({ q: '' }) }}>
              مسح
            </button>
          )}
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}
      {bulk.progress && <div className="card bulk-progress">{bulk.progress}</div>}
      {bulk.selected.size > 0 && can('payouts', 'can_approve') && (
        <div className="bulk-bar">
          <span>{bulk.selected.size} محدد</span>
          <button className="btn-primary btn-sm" disabled={bulk.busy} onClick={() => void bulk.run('approve')}>
            ✅ اعتماد الكل
          </button>
          <button className="btn-ghost danger btn-sm" disabled={bulk.busy} onClick={() => void bulk.run('decline')}>
            ❌ رفض الكل
          </button>
          <button className="btn-ghost btn-sm" disabled={bulk.busy} onClick={bulk.clear}>إلغاء</button>
        </div>
      )}

      <section className="card recent-card">
        {loading && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {!loading && data && data.rows.length === 0 && <p>لا توجد نتائج مطابقة.</p>}
        {!loading && data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  {can('payouts', 'can_approve') && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        checked={(() => {
                          const ids = data.rows.filter((r) => r.status === 'PENDING').map((r) => r.maven_id)
                          return ids.length > 0 && ids.every((i) => bulk.selected.has(i))
                        })()}
                        onChange={() => bulk.toggleAll(data.rows.filter((r) => r.status === 'PENDING').map((r) => r.maven_id))}
                      />
                    </th>
                  )}
                  <th>رقم العملية</th>
                  <th>المبلغ</th>
                  <th>المستفيد</th>
                  <th>الطريقة</th>
                  <th>التاجر</th>
                  <th>الوكيل</th>
                  <th>الحالة</th>
                  <th>الوقت</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = statusMeta(r.status)
                  return (
                    <tr key={r.maven_id} onClick={() => void openDetail(r.maven_id)}>
                      {can('payouts', 'can_approve') && (
                        <td className="check-col" onClick={(e) => e.stopPropagation()}>
                          {r.status === 'PENDING' && (
                            <input
                              type="checkbox"
                              checked={bulk.selected.has(r.maven_id)}
                              onChange={() => bulk.toggle(r.maven_id)}
                            />
                          )}
                        </td>
                      )}
                      <td className="mono">
                        {r.ontarget_ref ?? r.maven_id}
                        <div className="cell-sub mono" title="مرجع Maven">{r.maven_id}</div>
                      </td>
                      <td className="mono">{money(r.amount, CURRENCY)}</td>
                      <td>
                        {r.account_name ?? '—'}
                        {r.mobile_no && <div className="cell-sub mono">{r.mobile_no}</div>}
                      </td>
                      <td>{r.pay_by ?? '—'}</td>
                      <td>{r.merchant ?? '—'}</td>
                      <td>{r.agent_name ?? '—'}</td>
                      <td>
                        <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                        {r.approved_by && <div className="cell-sub">بواسطة {r.approved_by}</div>}
                      </td>
                      <td className="mono">{depositTime(r)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          <button
                            className="btn-ghost btn-sm"
                            title="تفاصيل السحب"
                            onClick={() => void openDetail(r.maven_id)}
                          >
                            👁 تفاصيل
                          </button>
                          {r.status === 'PENDING' && can('payouts', 'can_approve') && (
                            <>
                              <button
                                className="btn-primary btn-sm"
                                disabled={rowBusy === r.maven_id}
                                onClick={() => void quickDecide(r.maven_id, 'approve')}
                              >
                                ✅
                              </button>
                              <button
                                className="btn-ghost danger btn-sm"
                                disabled={rowBusy === r.maven_id}
                                onClick={() => void quickDecide(r.maven_id, 'decline')}
                              >
                                ❌
                              </button>
                            </>
                          )}
                        </div>
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
            <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>
              → السابق
            </button>
            <span className="pager-info mono">{page} / {totalPages}</span>
            <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>
              التالي ←
            </button>
          </div>
        )}
      </section>

      {(selected || detailLoading) && (
        <div className="drawer-backdrop" onClick={() => !decisionBusy && setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {detailLoading && <p className="sidebar-hint">جارٍ التحميل…</p>}
            {selected && (
              <>
                <div className="drawer-head">
                  <h3 className="mono">{selected.ontarget_ref ?? `Maven ${selected.maven_id}`}</h3>
                  <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
                </div>

                <div className="drawer-amount">
                  <span className="mono">{money(selected.amount, CURRENCY)}</span>
                  <span className={`pay-status-badge ${statusMeta(selected.status).cls}`}>
                    {statusMeta(selected.status).label}
                  </span>
                </div>

                <dl className="detail-grid">
                  <dt>مرجع Maven</dt><dd className="mono">{selected.maven_id}</dd>
                  <dt>GUID</dt><dd className="mono small">{selected.guid ?? '—'}</dd>
                  <dt>المستفيد</dt><dd>{selected.account_name ?? '—'} {selected.mobile_no && <span className="mono">({selected.mobile_no})</span>}</dd>
                  <dt>الطريقة</dt><dd>{selected.pay_by ?? '—'}</dd>
                  <dt>التاجر</dt><dd>{selected.merchant ?? '—'}</dd>
                  <dt>الوكيل</dt><dd>{selected.agent_name ?? '—'}</dd>
                  <dt>العمولة</dt><dd className="mono">{money(selected.commission, CURRENCY)}</dd>
                  <dt>ملاحظة</dt><dd>{selected.remark ?? '—'}</dd>
                  <dt>اعتمده</dt><dd>{selected.approved_by ?? '—'}</dd>
                  <dt>أول ظهور</dt><dd className="mono">{depositTime({ first_seen_at: selected.first_seen_at })}</dd>
                  <dt>آخر تحديث</dt><dd className="mono">{depositTime({ first_seen_at: selected.last_seen_at, created_utc: selected.updated_utc })}</dd>
                </dl>

                {selected.image_url && (
                  <a className="pay-status-link" href={selected.image_url} target="_blank" rel="noreferrer">
                    🧾 عرض إيصال التحويل
                  </a>
                )}

                {decisionErr && <div className="card warn">{decisionErr}</div>}

                {selected.status === 'PENDING' && can('payouts', 'can_approve') && (
                  <div className="drawer-actions">
                    <button className="btn-primary" disabled={decisionBusy} onClick={() => void decide('approve')}>
                      ✅ اعتماد
                    </button>
                    <button className="btn-ghost danger" disabled={decisionBusy} onClick={() => void decide('decline')}>
                      ❌ رفض
                    </button>
                  </div>
                )}
                {selected.status === 'PENDING' && !can('payouts', 'can_approve') && (
                  <p className="drawer-note">
                    الاعتماد/الرفض يتطلب صلاحية <span className="mono">can_approve</span> على صفحة
                    <span className="mono"> payouts</span> — غير ممنوحة لدورك حالياً.
                  </p>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </PanelShell>
  )
}
