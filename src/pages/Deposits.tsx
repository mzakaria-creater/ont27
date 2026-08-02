import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useBulk } from '../lib/useBulk'
import { depositTime, money, statusMeta, STATUS_META } from '../lib/deposits'
import type { DepositDetail, DepositRow, DepositStats } from '../lib/deposits'

const PAGE_SIZE = 25
const STATUS_FILTERS = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'UNDERPAID']
const MASTER_PILLS = [
  { key: 'NGPay', cls: 'ngpay' },
  { key: 'PayFuture', cls: 'payfuture' },
]

interface ListResponse {
  rows: DepositRow[]
  total: number
  limit: number
  offset: number
}

interface MatchedSms {
  id: number
  received_at: string | null
  device_name: string | null
  sim_slot: number | null
  sender_name: string | null
  sender_number: string | null
  amount: number | null
  balance_after: number | null
  sms_first_line: string | null
  match_status: string | null
  sec_diff: number | null
}

interface ClientHistory {
  total: number
  paid: number
  declined: number
}

function merchantChipCls(master: string | null | undefined): string {
  const m = (master ?? '').toLowerCase()
  if (m.includes('ngpay')) return 'ngpay'
  if (m.includes('payfuture')) return 'payfuture'
  return 'other'
}

function smsFirstLine(s: MatchedSms): string {
  const raw = s.sms_first_line ?? ''
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('From :'))[0] ?? '—'
}

export default function Deposits() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const master = params.get('master') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [data, setData] = useState<ListResponse | null>(null)
  const [stats, setStats] = useState<DepositStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<DepositDetail | null>(null)
  const [selectedSms, setSelectedSms] = useState<MatchedSms | null>(null)
  const [selectedClient, setSelectedClient] = useState<ClientHistory | null>(null)
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
    if (master) search.set('master', master)
    if (appliedQ) search.set('q', appliedQ)
    try {
      setData(await api<ListResponse>(`/api/deposits?${search}`))
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الإيداعات.' : 'تعذّر تحميل الإيداعات.')
    } finally {
      setLoading(false)
    }
  }, [status, master, appliedQ, page])

  useEffect(() => {
    api<DepositStats>('/api/deposits/stats').then(setStats).catch(() => setStats(null))
  }, [])

  useEffect(() => { void load() }, [load])

  const setFilter = (next: { status?: string; master?: string; q?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    if (next.status !== undefined) {
      if (next.status) p.set('status', next.status); else p.delete('status')
      p.delete('page')
    }
    if (next.master !== undefined) {
      if (next.master) p.set('master', next.master); else p.delete('master')
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
    setSelectedSms(null)
    setSelectedClient(null)
    try {
      const res = await api<{ deposit: DepositDetail; sms: MatchedSms | null; client: ClientHistory | null }>(`/api/deposits/${txId}`)
      setSelected(res.deposit)
      setSelectedSms(res.sms)
      setSelectedClient(res.client)
    } catch {
      setErr('تعذّر تحميل تفاصيل الإيداع.')
    } finally {
      setDetailLoading(false)
    }
  }

  const [rowBusy, setRowBusy] = useState<number | null>(null)
  const bulk = useBulk((id) => `/api/deposits/${id}/decision`, () => void load())

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

      <div className="kpi-grid">
        <button className="kpi-card amber kpi-clickable" onClick={() => setFilter({ status: 'PENDING' })} style={{ textAlign: 'inherit', cursor: 'pointer' }}>
          <span className="kpi-icon">⏳</span>
          <div className="kpi-value">{stats ? stats.pending : '…'}</div>
          <div className="kpi-label">معلّقة الآن</div>
        </button>
        <div className="kpi-card">
          <span className="kpi-icon">📈</span>
          <div className="kpi-value">{stats ? stats.day.paid.count : '…'}</div>
          <div className="kpi-label">مقبولة · آخر 24 ساعة</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">📉</span>
          <div className="kpi-value">{stats ? stats.day.declined : '…'}</div>
          <div className="kpi-label">مرفوضة · آخر 24 ساعة</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🪙</span>
          <div className="kpi-value">{stats ? money(stats.day.paid.volume, '') : '…'}</div>
          <div className="kpi-label">إجمالي المقبول · 24 ساعة (EGP)</div>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-pills">
          <button className={`pill${master === '' ? ' active' : ''}`} onClick={() => setFilter({ master: '' })}>
            الكل
          </button>
          {MASTER_PILLS.map((m) => (
            <button
              key={m.key}
              className={`pill${master === m.key ? ' active' : ''}`}
              onClick={() => setFilter({ master: master === m.key ? '' : m.key })}
            >
              <span className="pill-dot" style={{ background: `var(--${m.cls})` }} />
              {m.key}
            </button>
          ))}
        </div>
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
      {bulk.progress && <div className="card bulk-progress">{bulk.progress}</div>}
      {bulk.selected.size > 0 && can('deposits', 'can_approve') && (
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
                  {can('deposits', 'can_approve') && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        checked={(() => {
                          const ids = data.rows.filter((r) => r.status === 'PENDING').map((r) => r.tx_id)
                          return ids.length > 0 && ids.every((i) => bulk.selected.has(i))
                        })()}
                        onChange={() => bulk.toggleAll(data.rows.filter((r) => r.status === 'PENDING').map((r) => r.tx_id))}
                      />
                    </th>
                  )}
                  <th>رقم العملية</th>
                  <th>المبلغ</th>
                  <th>المُرسِل</th>
                  <th>محفظة الاستلام</th>
                  <th>SMS المطابقة</th>
                  <th>الطريقة</th>
                  <th>التاجر</th>
                  <th>الحالة</th>
                  <th>الوقت</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = statusMeta(r.status)
                  return (
                    <tr
                      key={r.tx_id}
                      className={r.status === 'PENDING' ? 'row-pending' : undefined}
                      onClick={() => void openDetail(r.tx_id)}
                    >
                      {can('deposits', 'can_approve') && (
                        <td className="check-col" onClick={(e) => e.stopPropagation()}>
                          {r.status === 'PENDING' && (
                            <input
                              type="checkbox"
                              checked={bulk.selected.has(r.tx_id)}
                              onChange={() => bulk.toggle(r.tx_id)}
                            />
                          )}
                        </td>
                      )}
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
                      <td className="mono">
                        {r.to_account_number ?? '—'}
                        {r.receiving_wallet && r.receiving_wallet !== r.to_account_number && (
                          <div className="cell-sub mono">{r.receiving_wallet}</div>
                        )}
                      </td>
                      <td>
                        {r.sms ? (
                          <>
                            <span className="pay-status-badge st-paid">✅ #{r.sms.id}</span>
                            <div className="cell-sub">
                              {r.sms.sender_name ?? ''}
                              {r.sms.balance_after != null && <span className="mono"> · رصيد {money(r.sms.balance_after, '')}</span>}
                            </div>
                          </>
                        ) : (
                          <span className="cell-sub">— بدون رسالة</span>
                        )}
                      </td>
                      <td>{r.payment_method ?? r.gateway ?? '—'}</td>
                      <td>
                        {r.master_merchant
                          ? <span className={`merchant-chip ${merchantChipCls(r.master_merchant)}`}>{r.master_merchant}</span>
                          : (r.merchant ?? '—')}
                        {r.master_merchant && r.merchant && <div className="cell-sub">{r.merchant}</div>}
                      </td>
                      <td>
                        <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                        {r.status !== 'PENDING' && (
                          <div className="cell-sub">
                            بواسطة {!r.approved_by || r.approved_by === 'Manual' ? 'النظام (آلي)' : r.approved_by}
                          </div>
                        )}
                      </td>
                      <td className="mono">{depositTime(r)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          <button
                            className="btn-ghost btn-sm"
                            title="تفاصيل المعاملة"
                            onClick={() => void openDetail(r.tx_id)}
                          >
                            👁
                          </button>
                          {!r.sms && (
                            <a
                              className="btn-ghost btn-sm"
                              title="دور على رسالة بنفس المبلغ"
                              href={`/sms?amount=${r.amount ?? ''}`}
                            >
                              🔎
                            </a>
                          )}
                          {r.proof_image_url && (
                            <a
                              className="btn-ghost btn-sm"
                              title="صورة الإثبات"
                              href={r.proof_image_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              📷
                            </a>
                          )}
                          {r.status === 'PENDING' && can('deposits', 'can_approve') && (
                            <>
                              <button
                                className="btn-primary btn-sm"
                                disabled={rowBusy === r.tx_id}
                                onClick={() => void quickDecide(r.tx_id, 'approve')}
                              >
                                ✅
                              </button>
                              <button
                                className="btn-ghost danger btn-sm"
                                disabled={rowBusy === r.tx_id}
                                onClick={() => void quickDecide(r.tx_id, 'decline')}
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

                {selectedSms && (
                  <div className="sms-match-card">
                    <div className="sms-match-head">
                      <span className="sms-match-title">✅ رسالة SMS مطابقة</span>
                      {selectedSms.sec_diff != null && (
                        <span className="match-pct mono">فارق {selectedSms.sec_diff} ث</span>
                      )}
                    </div>
                    <div className="sms-match-text">{smsFirstLine(selectedSms)}</div>
                    <div className="sms-match-meta">
                      <span className="mono">
                        {selectedSms.device_name ?? '—'}{selectedSms.sim_slot != null && <> · SIM {selectedSms.sim_slot}</>}
                      </span>
                      <span className="mono">استُلمت {depositTime({ first_seen_at: selectedSms.received_at })}</span>
                      {selectedSms.balance_after != null && (
                        <span className="mono">الرصيد بعدها {money(selectedSms.balance_after, 'EGP')}</span>
                      )}
                    </div>
                  </div>
                )}

                {selectedClient && selectedClient.total > 1 && (
                  <>
                    <div className="section-label">سجل هذا العميل</div>
                    <div className="client-history">
                      <div className="ch-tile">
                        <div className="ch-value">{selectedClient.total}</div>
                        <div className="ch-label">إجمالي</div>
                      </div>
                      <div className="ch-tile">
                        <div className="ch-value" style={{ color: 'var(--status-paid)' }}>{selectedClient.paid}</div>
                        <div className="ch-label">مقبولة</div>
                      </div>
                      <div className="ch-tile">
                        <div className="ch-value" style={{ color: 'var(--status-declined)' }}>{selectedClient.declined}</div>
                        <div className="ch-label">مرفوضة</div>
                      </div>
                    </div>
                  </>
                )}

                <div className="section-label">سجل النشاط</div>
                <div className="timeline">
                  {selected.status !== 'PENDING' && (
                    <div className="timeline-item">
                      <div className={`timeline-dot ${selected.status === 'PAID' || selected.status === 'APPROVED' ? 'done' : 'neutral'}`} />
                      <div>
                        <div className="timeline-title">القرار: {statusMeta(selected.status).label}</div>
                        <div className="timeline-meta mono">
                          {depositTime({ first_seen_at: selected.last_status_change })}
                          {selected.approved_by && <> · {selected.approved_by}</>}
                        </div>
                      </div>
                    </div>
                  )}
                  {selectedSms && (
                    <div className="timeline-item">
                      <div className="timeline-dot done" />
                      <div>
                        <div className="timeline-title">استُقبلت رسالة SMS مطابقة</div>
                        <div className="timeline-meta mono">
                          {depositTime({ first_seen_at: selectedSms.received_at })} · {selectedSms.device_name ?? '—'}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="timeline-item">
                    <div className="timeline-dot neutral" />
                    <div>
                      <div className="timeline-title">تم إنشاء المعاملة</div>
                      <div className="timeline-meta mono">
                        {depositTime(selected)} · {selected.master_merchant ?? selected.merchant ?? '—'}
                      </div>
                    </div>
                  </div>
                </div>

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
