import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta, STATUS_META } from '../lib/deposits'
import type { DepositDetail, DepositRow } from '../lib/deposits'

const PAGE_SIZE = 25
const STATUS_FILTERS = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'UNDERPAID']

interface ListResponse {
  rows: DepositRow[]
  total: number
  limit: number
  offset: number
}

export default function Deposits() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<DepositDetail | null>(null)
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
      setData(await api<ListResponse>(`/api/deposits?${search}`))
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الإيداعات.' : 'تعذّر تحميل الإيداعات.')
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

  const openDetail = async (txId: number) => {
    setDetailLoading(true)
    setDecisionErr(null)
    try {
      const res = await api<{ deposit: DepositDetail }>(`/api/deposits/${txId}`)
      setSelected(res.deposit)
    } catch {
      setErr('تعذّر تحميل تفاصيل الإيداع.')
    } finally {
      setDetailLoading(false)
    }
  }

  const [rowBusy, setRowBusy] = useState<number | null>(null)

  const quickDecide = async (txId: number, action: 'approve' | 'decline') => {
    setRowBusy(txId)
    setErr(null)
    try {
      await api(`/api/deposits/${txId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') {
        setErr('حالة الإيداع اتغيّرت بالفعل — أعد التحميل.')
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
      await api(`/api/deposits/${selected.tx_id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      setSelected(null)
      void load()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not_pending') {
        setDecisionErr('حالة الإيداع اتغيّرت بالفعل — أعد التحميل.')
      } else if (e instanceof ApiError && e.status === 403) {
        setDecisionErr('لا تملك صلاحية الموافقة (can_approve غير ممنوحة لدورك).')
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
        <h2>💰 الإيداعات</h2>
        <p className="page-sub">
          مصدر الحقيقة: <span className="mono">maven_transactions</span>
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
              {STATUS_META[s]?.label ?? s}
            </button>
          ))}
        </div>
        <form
          className="search-row"
          onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}
        >
          <input
            className="login-input search-input"
            placeholder="بحث: مرجع / رقم مُرسِل / تاجر / tx_id…"
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

      <section className="card recent-card">
        {loading && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {!loading && data && data.rows.length === 0 && <p>لا توجد نتائج مطابقة.</p>}
        {!loading && data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>رقم العملية</th>
                  <th>المبلغ</th>
                  <th>المُرسِل</th>
                  <th>الطريقة</th>
                  <th>التاجر</th>
                  <th>الحالة</th>
                  <th>الوقت</th>
                  {can('deposits', 'can_approve') && <th>إجراء</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = statusMeta(r.status)
                  return (
                    <tr key={r.tx_id} onClick={() => void openDetail(r.tx_id)}>
                      <td className="mono">
                        {r.ontarget_ref ?? r.tx_id}
                        {r.merchant_tx_reference && (
                          <div className="cell-sub mono" title="مرجع التاجر">{r.merchant_tx_reference}</div>
                        )}
                      </td>
                      <td className="mono">{money(r.amount, r.currency)}</td>
                      <td>
                        {r.sender_name ?? '—'}
                        {r.sender_number && <div className="cell-sub mono">{r.sender_number}</div>}
                      </td>
                      <td>{r.payment_method ?? r.gateway ?? '—'}</td>
                      <td>
                        {r.merchant ?? '—'}
                        {r.master_merchant && <div className="cell-sub">{r.master_merchant}</div>}
                      </td>
                      <td>
                        <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                        {r.approved_by && <div className="cell-sub">بواسطة {r.approved_by}</div>}
                      </td>
                      <td className="mono">{depositTime(r)}</td>
                      {can('deposits', 'can_approve') && (
                        <td onClick={(e) => e.stopPropagation()}>
                          {r.status === 'PENDING' && (
                            <div className="row-actions">
                              <button
                                className="btn-primary btn-sm"
                                disabled={rowBusy === r.tx_id}
                                onClick={() => void quickDecide(r.tx_id, 'approve')}
                              >
                                ✅ اعتماد
                              </button>
                              <button
                                className="btn-ghost danger btn-sm"
                                disabled={rowBusy === r.tx_id}
                                onClick={() => void quickDecide(r.tx_id, 'decline')}
                              >
                                ❌
                              </button>
                            </div>
                          )}
                        </td>
                      )}
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
                  <h3 className="mono">{selected.ontarget_ref ?? `tx ${selected.tx_id}`}</h3>
                  <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
                </div>

                <div className="drawer-amount">
                  <span className="mono">{money(selected.amount, selected.currency)}</span>
                  <span className={`pay-status-badge ${statusMeta(selected.status).cls}`}>
                    {statusMeta(selected.status).label}
                  </span>
                </div>

                <dl className="detail-grid">
                  <dt>tx_id</dt><dd className="mono">{selected.tx_id}</dd>
                  <dt>GUID</dt><dd className="mono small">{selected.guid ?? '—'}</dd>
                  <dt>المُرسِل</dt><dd>{selected.sender_name ?? '—'} {selected.sender_number && <span className="mono">({selected.sender_number})</span>}</dd>
                  <dt>إلى حساب</dt><dd>{selected.to_account_name ?? '—'} {selected.to_account_number && <span className="mono">{selected.to_account_number}</span>}</dd>
                  <dt>البنك / الطريقة</dt><dd>{selected.to_bank ?? '—'} · {selected.payment_method ?? selected.gateway ?? '—'}</dd>
                  <dt>التاجر</dt><dd>{selected.merchant ?? '—'}{selected.sub_merchant && <> · فرعي: {selected.sub_merchant}</>}</dd>
                  <dt>التاجر الرئيسي</dt><dd>{selected.master_merchant ?? '—'}</dd>
                  <dt>مرجع التاجر</dt><dd className="mono">{selected.merchant_tx_reference ?? '—'}</dd>
                  <dt>الرسوم / العمولة</dt><dd className="mono">{money(selected.fees, selected.currency)} / {money(selected.commission, selected.currency)}</dd>
                  <dt>المحفظة المستقبِلة</dt><dd className="mono">{selected.receiving_wallet ?? '—'}</dd>
                  <dt>أول ظهور</dt><dd className="mono">{depositTime({ first_seen_at: selected.first_seen_at })}</dd>
                  <dt>آخر تغيير حالة</dt><dd className="mono">{depositTime({ first_seen_at: selected.last_status_change })}</dd>
                  <dt>اعتمده</dt><dd>{selected.approved_by ?? '—'}</dd>
                  {selected.manual_entry && (
                    <>
                      <dt>إدخال يدوي</dt>
                      <dd>بواسطة {selected.manual_entry_by ?? '—'}{selected.manual_entry_note && <> — {selected.manual_entry_note}</>}</dd>
                    </>
                  )}
                  {selected.response_message && (
                    <><dt>رسالة النظام</dt><dd>{selected.response_message}</dd></>
                  )}
                </dl>

                {selected.proof_image_url && (
                  <a className="pay-status-link" href={selected.proof_image_url} target="_blank" rel="noreferrer">
                    🧾 عرض إثبات الدفع
                  </a>
                )}

                {decisionErr && <div className="card warn">{decisionErr}</div>}

                {selected.status === 'PENDING' && can('deposits', 'can_approve') && (
                  <div className="drawer-actions">
                    <button className="btn-primary" disabled={decisionBusy} onClick={() => void decide('approve')}>
                      ✅ اعتماد (PAID)
                    </button>
                    <button className="btn-ghost danger" disabled={decisionBusy} onClick={() => void decide('decline')}>
                      ❌ رفض
                    </button>
                  </div>
                )}
                {selected.status === 'PENDING' && !can('deposits', 'can_approve') && (
                  <p className="drawer-note">
                    الاعتماد/الرفض يتطلب صلاحية <span className="mono">can_approve</span> على صفحة
                    <span className="mono"> deposits</span> — غير ممنوحة لدورك حالياً.
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
