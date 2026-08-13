import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// SMS Live — the inbound_sms queue with its Maven links, auto-refreshing.

const PAGE_SIZE = 25
const REFRESH_MS = 15_000

const CATEGORY_META: Record<string, { ar: string; en: string; cls: string }> = {
  deposit: { ar: 'إيداع', en: 'Deposit', cls: 'st-paid' },
  withdrawal: { ar: 'سحب', en: 'Withdrawal', cls: 'st-declined' },
  balance: { ar: 'رصيد', en: 'Balance', cls: 'st-dim' },
  otp: { ar: 'OTP', en: 'OTP', cls: 'st-dim' },
  promotion: { ar: 'دعاية', en: 'Promo', cls: 'st-dim' },
  unknown: { ar: 'غير معروف', en: 'Unknown', cls: 'st-under' },
}

const MATCH_META: Record<string, { ar: string; en: string; cls: string }> = {
  auto: { ar: 'مرتبطة (آلي)', en: 'Linked (auto)', cls: 'st-paid' },
  manual: { ar: 'مرتبطة (يدوي)', en: 'Linked (manual)', cls: 'st-paid' },
  matched_paid: { ar: 'مرتبطة ومدفوعة', en: 'Linked & paid', cls: 'st-paid' },
  unmatched: { ar: 'غير مرتبطة', en: 'Unlinked', cls: 'st-dim' },
}

const MATCH_FILTERS = [
  { key: 'linked', ar: 'مرتبطة بمعاملة', en: 'Linked to tx' },
  { key: 'unmatched', ar: 'غير مرتبطة', en: 'Unlinked' },
  { key: 'review', ar: 'تحتاج مراجعة', en: 'Needs review' },
]

interface SmsRow {
  id: number
  received_at: string | null
  device_name: string | null
  sim_slot: number | null
  sender_number: string | null
  sender_name: string | null
  receiver_number: string | null
  amount: number | null
  balance_after: number | null
  sms_category: string | null
  match_status: string | null
  matched: boolean | null
  review_required: boolean | null
  trx_id: string | null
  matched_transaction_id: string | null
  maven_transaction_id: number | null
  provider: string | null
  sms_first_line: string | null
}

interface SmsDetail extends SmsRow {
  message: string | null
  sms_sender: string | null
  wallet: string | null
  notes: string | null
  assigned_operator: string | null
  risk_score: number | null
  risk_reason: string | null
  is_duplicate: boolean | null
  maven_guid: string | null
  manual_entry: boolean | null
  manual_entry_by: string | null
  manual_entry_note: string | null
  created_at: string | null
}

interface SmsStats {
  total: number
  deposits: { count: number; dayVolume: number }
  withdrawals: { count: number; dayVolume: number }
  linked: number
  review: number
}

interface ListResponse {
  rows: SmsRow[]
  total: number
  limit: number
  offset: number
}

interface CandidateTx {
  tx_id: number
  ontarget_ref: string | null
  status: string
  amount: number | null
  currency: string | null
  sender_name: string | null
  sender_number: string | null
  merchant: string | null
  first_seen_at: string | null
}

function firstLine(r: SmsRow): string {
  const raw = r.sms_first_line ?? ''
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('From :'))[0]
  return line ?? '—'
}

export default function SmsLive() {
  const { can } = useAuth()
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const category = params.get('category') ?? ''
  const match = params.get('match') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const [q, setQ] = useState(params.get('q') ?? '')
  const [data, setData] = useState<ListResponse | null>(null)
  const [stats, setStats] = useState<SmsStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<SmsDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [candidates, setCandidates] = useState<CandidateTx[] | null>(null)
  const [candQ, setCandQ] = useState('')
  const [candLoading, setCandLoading] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkErr, setLinkErr] = useState<string | null>(null)

  const appliedQ = params.get('q') ?? ''
  const amount = params.get('amount') ?? ''

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const search = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    })
    if (category) search.set('category', category)
    if (match) search.set('match', match)
    if (appliedQ) search.set('q', appliedQ)
    if (amount) search.set('amount', amount)
    try {
      const [list, st] = await Promise.all([
        api<ListResponse>(`/api/sms?${search}`),
        api<SmsStats>('/api/sms/stats'),
      ])
      setData(list)
      setStats(st)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض رسائل SMS.', 'You do not have permission to view SMS.') : t('تعذّر تحميل الرسائل.', 'Failed to load messages.'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [category, match, appliedQ, amount, page])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const iv = setInterval(() => void load(true), REFRESH_MS)
    return () => clearInterval(iv)
  }, [load])

  const setFilter = (next: { category?: string; match?: string; q?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    const setOrDel = (key: string, v: string | undefined) => {
      if (v === undefined) return
      if (v) p.set(key, v); else p.delete(key)
      p.delete('page')
    }
    setOrDel('category', next.category)
    setOrDel('match', next.match)
    setOrDel('q', next.q)
    if (next.page !== undefined) {
      if (next.page > 1) p.set('page', String(next.page)); else p.delete('page')
    }
    setParams(p)
  }

  const loadCandidates = async (id: number, search?: string) => {
    setCandLoading(true)
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : ''
      const res = await api<{ candidates: CandidateTx[] }>(`/api/sms/${id}/candidates${qs}`)
      setCandidates(res.candidates)
    } catch {
      setCandidates([])
    } finally {
      setCandLoading(false)
    }
  }

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setLinkErr(null)
    setCandidates(null)
    setCandQ('')
    try {
      const res = await api<{ sms: SmsDetail }>(`/api/sms/${id}`)
      setSelected(res.sms)
      if (!res.sms.matched && can('sms_live', 'can_edit')) void loadCandidates(id)
    } catch {
      setErr(t('تعذّر تحميل تفاصيل الرسالة.', 'Failed to load message details.'))
    } finally {
      setDetailLoading(false)
    }
  }

  const link = async (txId: number) => {
    if (!selected) return
    setLinkBusy(true)
    setLinkErr(null)
    try {
      await api(`/api/sms/${selected.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ tx_id: txId }),
      })
      setSelected(null)
      void load(true)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_linked') {
        setLinkErr(t('الرسالة مرتبطة بالفعل — أعد الفتح.', 'Message already linked — reopen.'))
      } else if (e instanceof ApiError && e.status === 403) {
        setLinkErr(t('لا تملك صلاحية الربط (can_edit غير ممنوحة لدورك).', 'You lack link permission (can_edit not granted to your role).'))
      } else {
        setLinkErr(t('فشل الربط — حاول مرة أخرى.', 'Link failed — try again.'))
      }
    } finally {
      setLinkBusy(false)
    }
  }

  const unlink = async () => {
    if (!selected) return
    setLinkBusy(true)
    setLinkErr(null)
    try {
      await api(`/api/sms/${selected.id}/unlink`, { method: 'POST' })
      setSelected(null)
      void load(true)
    } catch {
      setLinkErr(t('فشل فك الربط — حاول مرة أخرى.', 'Unlink failed — try again.'))
    } finally {
      setLinkBusy(false)
    }
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1

  return (
    <PanelShell>
      <section className="page-head">
        <div className="recent-head">
          <h2 style={{ margin: 0 }}>📨 {t('SMS مباشر', 'Live SMS')}</h2>
          <Link to="/wallet-report" className="btn-ghost btn-sm">📊 {t('تقرير المحافظ ←', 'Wallet report →')}</Link>
        </div>
        <p className="page-sub">
          {t('صندوق الرسائل الوارد من أجهزة المحافظ · تحديث تلقائي كل', 'Inbox from the wallet devices · auto-refresh every')} {REFRESH_MS / 1000} {t('ثانية', 's')}
          {data && <> · {data.total.toLocaleString('en-US')}</>}
        </p>
      </section>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">{t('إجمالي الرسائل', 'Total messages')}</span>
          <span className="stat-value">{stats ? stats.total.toLocaleString('en-US') : '…'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('إيداعات', 'Deposits')}</span>
          <span className="stat-value">{stats ? stats.deposits.count.toLocaleString('en-US') : '…'}</span>
          <span className="stat-sub">{stats ? `${money(stats.deposits.dayVolume, 'EGP')} · ${t('آخر 24س', 'last 24h')}` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('سحوبات', 'Withdrawals')}</span>
          <span className="stat-value">{stats ? stats.withdrawals.count.toLocaleString('en-US') : '…'}</span>
          <span className="stat-sub">{stats ? `${money(stats.withdrawals.dayVolume, 'EGP')} · ${t('آخر 24س', 'last 24h')}` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('مرتبطة بمعاملات', 'Linked to tx')}</span>
          <span className="stat-value">{stats ? stats.linked.toLocaleString('en-US') : '…'}</span>
          <span className="stat-sub">{stats && stats.total > 0 ? `${Math.round((stats.linked / stats.total) * 100)}% ${t('تغطية', 'coverage')}` : ''}</span>
        </div>
        <div className="stat-card stat-pending">
          <span className="stat-label">{t('تحتاج مراجعة', 'Needs review')}</span>
          <span className="stat-value">{stats ? stats.review.toLocaleString('en-US') : '…'}</span>
        </div>
      </div>

      <div className="filter-bar">
        <div className="chip-row">
          <button
            className={`chip${category === '' ? ' chip-active' : ''}`}
            onClick={() => setFilter({ category: '' })}
          >
            {t('الكل', 'All')}
          </button>
          {['deposit', 'withdrawal', 'unknown'].map((c) => (
            <button
              key={c}
              className={`chip${category === c ? ' chip-active' : ''}`}
              onClick={() => setFilter({ category: category === c ? '' : c })}
            >
              {t(CATEGORY_META[c].ar, CATEGORY_META[c].en)}
            </button>
          ))}
          <span className="chip-sep" />
          {MATCH_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip${match === f.key ? ' chip-active' : ''}`}
              onClick={() => setFilter({ match: match === f.key ? '' : f.key })}
            >
              {t(f.ar, f.en)}
            </button>
          ))}
        </div>
        <form
          className="search-row"
          onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}
        >
          <input
            className="login-input search-input"
            placeholder={t('بحث: مُرسِل / محفظة / رقم عملية / جهاز…', 'Search: sender / wallet / tx id / device…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>
          {appliedQ && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => { setQ(''); setFilter({ q: '' }) }}>
              {t('مسح', 'Clear')}
            </button>
          )}
          {amount && (
            <button
              type="button"
              className="chip chip-active"
              onClick={() => { const p = new URLSearchParams(params); p.delete('amount'); setParams(p) }}
            >
              {t('مبلغ', 'Amount')} = {amount} ✕
            </button>
          )}
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {loading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {!loading && data && data.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {!loading && data && data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>{t('الرسالة', 'Message')}</th>
                  <th>{t('النوع', 'Type')}</th>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('مُرسِل ← مستقبِل', 'Sender ← receiver')}</th>
                  <th>{t('الجهاز', 'Device')}</th>
                  <th>{t('رقم العملية', 'Tx id')}</th>
                  <th>{t('الربط', 'Link')}</th>
                  <th>{t('الوقت', 'Time')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const cat = r.sms_category ? CATEGORY_META[r.sms_category] : null
                  const mt = r.match_status ? MATCH_META[r.match_status] : null
                  return (
                    <tr key={r.id} onClick={() => void openDetail(r.id)}>
                      <td className="sms-cell">
                        {firstLine(r)}
                        <div className="cell-sub mono">#{r.id} · {r.provider ?? '—'}</div>
                      </td>
                      <td>
                        {cat
                          ? <span className={`pay-status-badge ${cat.cls}`}>{t(cat.ar, cat.en)}</span>
                          : <span className="mono">—</span>}
                      </td>
                      <td className="mono">
                        {money(r.amount, 'EGP')}
                        {r.balance_after != null && <div className="cell-sub mono">{t('رصيد', 'bal')} {money(r.balance_after, 'EGP')}</div>}
                      </td>
                      <td>
                        {r.sender_name ?? r.sender_number ?? '—'}
                        <div className="cell-sub mono">← {r.receiver_number ?? '—'}</div>
                      </td>
                      <td className="mono">
                        {r.device_name ?? '—'}
                        {r.sim_slot != null && <div className="cell-sub mono">SIM {r.sim_slot}</div>}
                      </td>
                      <td className="mono">
                        {r.trx_id ?? '—'}
                        {r.maven_transaction_id && <div className="cell-sub mono">OnTarget {r.maven_transaction_id}</div>}
                      </td>
                      <td>
                        {mt
                          ? <span className={`pay-status-badge ${mt.cls}`}>{t(mt.ar, mt.en)}</span>
                          : <span className="mono">{r.match_status ?? '—'}</span>}
                        {r.review_required && !r.matched && <div className="cell-sub">⚠ {t('مراجعة', 'review')}</div>}
                      </td>
                      <td className="mono">{depositTime({ first_seen_at: r.received_at })}</td>
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
              → {t('السابق', 'Prev')}
            </button>
            <span className="pager-info mono">{page} / {totalPages}</span>
            <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>
              {t('التالي', 'Next')} ←
            </button>
          </div>
        )}
      </section>

      {(selected || detailLoading) && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {detailLoading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
            {selected && (
              <>
                <div className="drawer-head">
                  <h3 className="mono">SMS #{selected.id}</h3>
                  <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
                </div>

                <div className="drawer-amount">
                  <span className="mono">{money(selected.amount, 'EGP')}</span>
                  {selected.sms_category && CATEGORY_META[selected.sms_category] && (
                    <span className={`pay-status-badge ${CATEGORY_META[selected.sms_category].cls}`}>
                      {t(CATEGORY_META[selected.sms_category].ar, CATEGORY_META[selected.sms_category].en)}
                    </span>
                  )}
                </div>

                {selected.message && (
                  <pre className="sms-body">{selected.message}</pre>
                )}

                <dl className="detail-grid">
                  <dt>{t('المُرسِل', 'Sender')}</dt><dd>{selected.sender_name ?? '—'} {selected.sender_number && <span className="mono">({selected.sender_number})</span>}</dd>
                  <dt>{t('المحفظة المستقبِلة', 'Receiving wallet')}</dt><dd className="mono">{selected.receiver_number ?? selected.wallet ?? '—'}</dd>
                  <dt>{t('المزوّد', 'Provider')}</dt><dd>{selected.provider ?? '—'} · <span className="mono">{selected.sms_sender ?? '—'}</span></dd>
                  <dt>{t('الجهاز', 'Device')}</dt><dd className="mono">{selected.device_name ?? '—'}{selected.sim_slot != null && <> · SIM {selected.sim_slot}</>}</dd>
                  <dt>{t('رقم العملية (SMS)', 'Tx id (SMS)')}</dt><dd className="mono">{selected.trx_id ?? '—'}</dd>
                  <dt>{t('معاملة OnTarget', 'OnTarget tx')}</dt><dd className="mono">{selected.maven_transaction_id ?? selected.matched_transaction_id ?? '—'}</dd>
                  <dt>{t('حالة الربط', 'Link status')}</dt><dd className="mono">{selected.match_status ?? '—'}{selected.review_required && !selected.matched && <> · ⚠ {t('تحتاج مراجعة', 'needs review')}</>}</dd>
                  <dt>{t('الرصيد بعد العملية', 'Balance after')}</dt><dd className="mono">{money(selected.balance_after, 'EGP')}</dd>
                  {selected.risk_score != null && selected.risk_score > 0 && (
                    <><dt>{t('درجة الخطورة', 'Risk score')}</dt><dd className="mono">{selected.risk_score}{selected.risk_reason && <> — {selected.risk_reason}</>}</dd></>
                  )}
                  {selected.is_duplicate && <><dt>{t('تكرار', 'Duplicate')}</dt><dd>⚠ {t('رسالة مكررة', 'Duplicate message')}</dd></>}
                  <dt>{t('المشغّل المسؤول', 'Assigned operator')}</dt><dd>{selected.assigned_operator ?? '—'}</dd>
                  {selected.notes && <><dt>{t('ملاحظات', 'Notes')}</dt><dd>{selected.notes}</dd></>}
                  <dt>{t('وقت الاستلام', 'Received at')}</dt><dd className="mono">{depositTime({ first_seen_at: selected.received_at })}</dd>
                </dl>

                {linkErr && <div className="card warn">{linkErr}</div>}

                {selected.matched && can('sms_live', 'can_edit') && (
                  <div className="drawer-actions">
                    <button className="btn-ghost danger" disabled={linkBusy} onClick={() => void unlink()}>
                      🔗 {t('فك الربط عن المعاملة', 'Unlink from transaction')}
                    </button>
                  </div>
                )}

                {!selected.matched && can('sms_live', 'can_edit') && (
                  <div className="link-section">
                    <h4>🔗 {t('ربط بمعاملة', 'Link to a transaction')}</h4>
                    <form
                      className="search-row"
                      onSubmit={(e) => { e.preventDefault(); void loadCandidates(selected.id, candQ.trim() || undefined) }}
                    >
                      <input
                        className="login-input search-input"
                        placeholder={t('بحث بالمرجع أو tx_id… (فارغ = ترشيح بنفس المبلغ)', 'Search by ref or tx_id… (empty = same-amount candidates)')}
                        value={candQ}
                        onChange={(e) => setCandQ(e.target.value)}
                      />
                      <button type="submit" className="btn-ghost btn-sm" disabled={candLoading}>{t('بحث', 'Search')}</button>
                    </form>
                    {candLoading && <p className="sidebar-hint">{t('جارٍ البحث عن معاملات مطابقة…', 'Searching for matching transactions…')}</p>}
                    {candidates && candidates.length === 0 && !candLoading && (
                      <p className="sidebar-hint">{t('لا توجد معاملات مرشّحة — جرّب البحث بالمرجع.', 'No candidate transactions — try searching by ref.')}</p>
                    )}
                    {candidates && candidates.length > 0 && (
                      <ul className="cand-list">
                        {candidates.map((cand) => (
                          <li key={cand.tx_id} className="cand-item">
                            <div className="cand-info">
                              <span className="mono">{cand.ontarget_ref ?? cand.tx_id}</span>
                              <span className={`pay-status-badge ${statusMeta(cand.status).cls}`}>{statusMeta(cand.status).label}</span>
                              <div className="cell-sub">
                                <span className="mono">{money(cand.amount, cand.currency)}</span>
                                {' · '}{cand.sender_name ?? cand.sender_number ?? '—'}
                                {' · '}{cand.merchant ?? '—'}
                                {' · '}<span className="mono">{depositTime({ first_seen_at: cand.first_seen_at })}</span>
                              </div>
                            </div>
                            <button
                              className="btn-primary btn-sm"
                              disabled={linkBusy}
                              onClick={() => void link(cand.tx_id)}
                            >
                              {t('ربط', 'Link')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </PanelShell>
  )
}
