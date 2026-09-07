import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import ProofModal from '../components/ProofModal'
import ProofIconButton from '../components/ProofIconButton'
import DepositCard from '../components/DepositCard'
import type { CardAction } from '../components/DepositCard'
import { api, ApiError } from '../lib/api'
import { useBulk } from '../lib/useBulk'
import { useLocale } from '../lib/locale'
import MethodLogo from '../components/MethodLogo'
import { depositTime, isAutomaticApprovalActor, merchantChipCls, money, statusMeta } from '../lib/deposits'
import type { DepositDetail, DepositRow, DepositStats } from '../lib/deposits'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'
import DepositKindBadge from '../components/DepositKindBadge'
import { syncProviders } from '../lib/providerSync'
import { AlertTriangle, Search, X } from 'lucide-react'
import SmsMatchQueues, { type QueueSms } from '../components/SmsMatchQueues'

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

interface SmsQueues { waiting: QueueSms[]; unlinked: QueueSms[] }

function smsFirstLine(s: MatchedSms): string {
  const raw = s.sms_first_line ?? ''
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('From :'))[0] ?? '—'
}

export default function Deposits() {
  const [pageSize, setPageSize] = usePageSize('deposits')
  const { can } = useAuth()
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const master = params.get('master') ?? ''
  const view = params.get('view') === 'cards' ? 'cards' : 'table'
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
  const [smsQueues, setSmsQueues] = useState<SmsQueues>({ waiting: [], unlinked: [] })

  const appliedQ = params.get('q') ?? ''
  useEffect(() => setQ(appliedQ), [appliedQ])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const search = new URLSearchParams({
      limit: String(pageSize),
      offset: String((page - 1) * pageSize),
    })
    if (status) search.set('status', status)
    if (master) search.set('master', master)
    if (appliedQ) search.set('q', appliedQ)
    try {
      const next = await api<ListResponse>(`/api/deposits?${search}`)
      setData((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الإيداعات.' : 'تعذّر تحميل الإيداعات.')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [status, master, appliedQ, page, pageSize])

  useEffect(() => {
    let alive = true
    const refresh = async (silent = false) => {
      const sync = syncProviders()
      const read = () => Promise.all([
        load(silent),
        api<DepositStats>('/api/deposits/stats').then((value) => { if (alive) setStats(value) }).catch(() => { if (alive) setStats(null) }),
        api<SmsQueues>('/api/sms/queues').then((value) => { if (alive) setSmsQueues({ waiting: value.waiting ?? [], unlinked: value.unlinked ?? [] }) }).catch(() => { if (alive) setSmsQueues({ waiting: [], unlinked: [] }) }),
      ])
      await read()
      if (!alive) return
      if (await sync) await read()
    }
    void refresh(false)
    const interval = setInterval(() => void refresh(true), 10_000)
    return () => { alive = false; clearInterval(interval) }
  }, [load])

  const setFilter = (next: { status?: string; master?: string; q?: string; page?: number; view?: string }) => {
    const p = new URLSearchParams(params)
    if (next.view !== undefined) {
      if (next.view === 'cards') p.set('view', 'cards'); else p.delete('view')
    }
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

  // Which card/row is mid-flight, and for which action — the card layout shows
  // "جارٍ التنفيذ…" on the exact button that was pressed and disables the rest,
  // which is the fix for operators double-clicking Approve during the (real,
  // multi-second) provider round-trip.
  const [rowBusy, setRowBusy] = useState<{ id: number; action: CardAction } | null>(null)
  const [proofUrl, setProofUrl] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [retryLocked, setRetryLocked] = useState(false)
  const bulk = useBulk((id) => `/api/deposits/${id}/decision`, () => void load())

  // The deposits list had no auto-refresh at all: an operator watching this page
  // never saw a new transaction until they reloaded by hand. Refresh every 30s,
  // but hold off while a decision is in flight, the detail drawer is open, or
  // rows are selected for a bulk action — re-rendering the table under someone
  // mid-decision is worse than a few seconds of staleness. Filters and page are
  // captured in `load`, so a refresh keeps whatever the operator is looking at.
  useEffect(() => {
    const iv = setInterval(() => {
      if (rowBusy || decisionBusy || selected || bulk.selected.size > 0) return
      void load()
    }, 30_000)
    return () => clearInterval(iv)
  }, [load, rowBusy, decisionBusy, selected, bulk.selected.size])
  const armRetryCooldown = (ms: number) => {
    setRetryLocked(true)
    setTimeout(() => setRetryLocked(false), ms)
  }

  // The provider worker (ngpay-approve) already retries transient 5xx errors
  // internally before giving up — a failed response here means that already
  // failed a few times. Surface the real reason instead of a generic message,
  // and enforce a short cooldown so the operator can't immediately hammer the
  // same failing call again (that's what produced 3 identical failed attempts
  // on tx_id=138452815).
  const RETRY_COOLDOWN_MS = 10_000
  function describeDecisionError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.code === 'not_pending') return 'حالة الإيداع اتغيّرت بالفعل — أعد التحميل.'
      if (e.status === 403) return 'لا تملك صلاحية الاعتماد (can_approve غير ممنوحة لدورك).'
      if (e.code === 'worker_failed') {
        const providerMsg = (e.body?.worker as Record<string, unknown> | undefined)?.error
        return `فشل الاتصال بمزوّد NGPay${typeof providerMsg === 'string' ? `: ${providerMsg}` : ''} — لم يُنفَّذ أي تغيير، حاول مرة أخرى بعد قليل.`
      }
    }
    return 'فشل تنفيذ القرار — حاول مرة أخرى.'
  }

  const quickDecide = async (txId: number, action: 'approve' | 'decline') => {
    if (rowBusy) return
    setRowBusy({ id: txId, action })
    setErr(null)
    setNotice(null)
    try {
      await api(`/api/deposits/${txId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      void load()
    } catch (e) {
      setErr(describeDecisionError(e))
      if (e instanceof ApiError && e.code === 'not_pending') void load()
      else armRetryCooldown(RETRY_COOLDOWN_MS)
    } finally {
      setRowBusy(null)
    }
  }

  // Blocks the sender's number through the existing risk endpoint — same route
  // the velocity view uses, which already writes an audit_log row. No new
  // backend logic; a number that is already blocked comes back as 409.
  const blockSender = async (row: DepositRow) => {
    const value = row.sender_number?.trim()
    if (!value || rowBusy) return
    if (!window.confirm(t(`حظر الرقم ${value} نهائياً؟`, `Block ${value} permanently?`))) return
    setRowBusy({ id: row.tx_id, action: 'block' })
    setErr(null)
    setNotice(null)
    try {
      await api('/api/risk/blacklist', {
        method: 'POST',
        body: JSON.stringify({
          type: 'phone',
          value,
          reason: `Blocked from the deposits card view · ${row.ontarget_ref ?? row.tx_id}`,
        }),
      })
      setNotice(t(`تم حظر ${value}.`, `${value} is now blocked.`))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNotice(t(`${value} محظور بالفعل.`, `${value} is already blocked.`))
      else if (e instanceof ApiError && e.status === 403) setErr(t('لا تملك صلاحية الحظر (can_edit على صفحات المخاطر).', 'You lack blocking permission (can_edit on a risk page).'))
      else setErr(t('تعذّر إضافة الرقم للقائمة السوداء.', 'Could not add the number to the blacklist.'))
    } finally {
      setRowBusy(null)
    }
  }

  const canBlock = ['risk', 'risk_audit', 'flagged', 'velocity', 'compliance'].some((p) => can(p, 'can_edit'))

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
      setDecisionErr(describeDecisionError(e))
      if (!(e instanceof ApiError && e.code === 'not_pending')) armRetryCooldown(RETRY_COOLDOWN_MS)
    } finally {
      setDecisionBusy(false)
    }
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1

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

      <div className="filter-bar transaction-filter-toolbar">
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
              {statusMeta(s).label}
            </button>
          ))}
        </div>
        <form
          className="search-row trx-search-bar"
          role="search"
          onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}
        >
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            className="login-input search-input"
            aria-label={t('بحث الإيداعات', 'Search deposits')}
            placeholder="بحث: مبلغ / اسم أو رقم المرسل / رقم العملية / مرجع التاجر / رقم المستخدم…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="btn-primary btn-sm">بحث</button>
          {(q || appliedQ) && <button type="button" className="trx-search-clear" onClick={() => { setQ(''); setFilter({ q: '' }) }} aria-label={t('مسح البحث', 'Clear search')}><X size={15}/></button>}
        </form>
        <div className="view-toggle" role="group" aria-label={t('طريقة العرض', 'View mode')}>
          <button
            className={`pill${view === 'table' ? ' active' : ''}`}
            aria-pressed={view === 'table'}
            onClick={() => setFilter({ view: 'table' })}
          >
            ☰ {t('جدول', 'Table')}
          </button>
          <button
            className={`pill${view === 'cards' ? ' active' : ''}`}
            aria-pressed={view === 'cards'}
            onClick={() => setFilter({ view: 'cards' })}
          >
            ▦ {t('بطاقات', 'Cards')}
          </button>
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}
      {notice && <div className="card">{notice}</div>}
      <SmsMatchQueues waiting={smsQueues.waiting} unlinked={smsQueues.unlinked} loading={loading && !data} />
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

      {loading && !data && <p className="sidebar-hint">جارٍ التحميل…</p>}
      {data && data.rows.length === 0 && (
        <section className="card recent-card"><p>لا توجد نتائج مطابقة.</p></section>
      )}

      {view === 'cards' && data && data.rows.length > 0 && (
        <div className="dep-card-grid">
          {data.rows.map((r) => (
            <DepositCard
              key={r.tx_id}
              row={r}
              canApprove={can('deposits', 'can_approve')}
              canBlock={canBlock}
              busy={rowBusy?.id === r.tx_id ? rowBusy.action : null}
              locked={retryLocked}
              onOpen={() => void openDetail(r.tx_id)}
              onProof={setProofUrl}
              onApprove={() => void quickDecide(r.tx_id, 'approve')}
              onDecline={() => void quickDecide(r.tx_id, 'decline')}
              onBlock={() => void blockSender(r)}
            />
          ))}
        </div>
      )}

      {view === 'table' && data && data.rows.length > 0 && (
        <section className="card recent-card">
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
                  <th>إجراء</th>
                  <th>رقم العملية</th>
                  <th>المبلغ</th>
                  <th>المُرسِل</th>
                  <th>محفظة الاستلام</th>
                  <th>SMS المطابقة</th>
                  <th>الطريقة</th>
                  <th>التاجر</th>
                  <th>الحالة</th>
                  <th>اعتمد بواسطة</th>
                  <th>الوقت</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = statusMeta(r.status)
                  const approvedWithoutSms = !r.sms && (r.status === 'PAID' || r.status === 'APPROVED')
                  return (
                    <tr
                      key={r.tx_id}
                      className={`${r.status === 'PENDING' ? 'row-pending' : ''}${approvedWithoutSms ? ' row-sms-warning' : ''}`}
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
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions">
                          <button className="btn-ghost btn-sm" title="تفاصيل المعاملة" onClick={() => void openDetail(r.tx_id)}>👁</button>
                          {!r.sms && <a className="btn-ghost btn-sm" title="دور على رسالة بنفس المبلغ" href={`/sms?amount=${r.amount ?? ''}`}>🔎</a>}
                          {r.proof_image_url && <ProofIconButton url={r.proof_image_url} onOpen={setProofUrl} compact />}
                          {r.status === 'PENDING' && can('deposits', 'can_approve') && <>
                            <button className="btn-primary btn-sm" disabled={rowBusy !== null || retryLocked} onClick={() => void quickDecide(r.tx_id, 'approve')}>{rowBusy?.id === r.tx_id && rowBusy.action === 'approve' ? '⏳' : '✅'}</button>
                            <button className="btn-ghost danger btn-sm" disabled={rowBusy !== null || retryLocked} onClick={() => void quickDecide(r.tx_id, 'decline')}>{rowBusy?.id === r.tx_id && rowBusy.action === 'decline' ? '⏳' : '❌'}</button>
                          </>}
                        </div>
                      </td>
                      <td className="mono">
                        {approvedWithoutSms && <span className="sms-missing-warning-dot" title="Approved transaction without linked SMS" aria-label="Approved transaction without linked SMS"><AlertTriangle size={11} aria-hidden="true" /></span>}
                        {r.ontarget_ref ?? r.tx_id}
                        {(r.merchant_reference ?? r.merchant_tx_reference) && (
                          <div className="cell-sub mono" title="NGPay merchant reference">{r.merchant_reference ?? r.merchant_tx_reference}</div>
                        )}
                      </td>
                      <td className="mono">{money(r.amount, r.currency)}</td>
                      <td>
                        {r.sender_name ?? '—'}
                        {r.sender_number && <div className="cell-sub mono">{r.sender_number}</div>}
                        {r.sender_account_number && r.sender_account_number !== r.sender_number && <div className="cell-sub mono">{t('حساب المرسل','Sender account')}: {r.sender_account_number}</div>}
                        <DepositKindBadge row={r} />
                      </td>
                      <td className="mono">
                        {r.receiving_wallet ?? r.to_account_number ?? '—'}
                        {r.to_account_number && r.receiving_wallet && r.receiving_wallet !== r.to_account_number && (
                          <div className="cell-sub mono">{t('المخصص: ', 'Allocated: ')}{r.to_account_number}</div>
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
                          <span className={approvedWithoutSms ? 'sms-missing-cell' : 'cell-sub'}>{approvedWithoutSms && <AlertTriangle size={13} aria-hidden="true" />} {approvedWithoutSms ? 'تحذير: بدون SMS' : '— بدون رسالة'}</span>
                        )}
                      </td>
                      <td><MethodLogo method={r.payment_method ?? r.gateway} /></td>
                      <td>
                        {r.master_merchant
                          ? <span className={`merchant-chip ${merchantChipCls(r.master_merchant)}`}>{r.master_merchant}</span>
                          : (r.merchant ?? '—')}
                        {r.master_merchant && r.merchant && <div className="cell-sub">{r.merchant}</div>}
                      </td>
                      <td>
                        <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                        {r.ngpay_status && (
                          <div className={`provider-row-status ${st.cls}`} title={t('الحالة القادمة من NagoPay', 'Status received from NagoPay')}>
                            NagoPay · {r.ngpay_status}
                          </div>
                        )}
                      </td>
                      <td>{r.status === 'PENDING' ? '—' : (isAutomaticApprovalActor(r.approved_by) ? 'آلي (Auto)' : r.approved_by)}</td>
                      <td className="mono">{depositTime(r)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && totalPages > 1 && (
        <div className="card pager">
          <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>
            → السابق
          </button>
          <PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setFilter({ page: 1 }) }} />
            <span className="pager-info mono">{page} / {totalPages}</span>
          <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>
            التالي ←
          </button>
        </div>
      )}

      {proofUrl && (
        <ProofModal url={proofUrl} title={t('إثبات الدفع', 'Payment proof')} onClose={() => setProofUrl(null)} />
      )}

      {(selected || detailLoading) && (
        <div className="drawer-backdrop" onClick={() => !decisionBusy && setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {detailLoading && <p className="sidebar-hint">جارٍ التحميل…</p>}
            {selected && (
              <>
                <div className="drawer-head">
                  <h3 className="mono">{selected.ontarget_ref ?? `tx ${selected.tx_id}`}</h3>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {selected.ontarget_ref && (
                      <a className="btn-ghost btn-sm" href={`/transactions/${encodeURIComponent(selected.ontarget_ref)}`}>
                        ↗ صفحة كاملة
                      </a>
                    )}
                    <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
                  </div>
                </div>

                <div className="drawer-amount">
                  <span className="mono">{money(selected.amount, selected.currency)}</span>
                  <span className={`pay-status-badge ${statusMeta(selected.status).cls}`}>
                    {statusMeta(selected.status).label}
                  </span>
                </div>

                <DepositKindBadge row={selected} />

                <dl className="detail-grid">
                  <dt>tx_id</dt><dd className="mono">{selected.tx_id}</dd>
                  <dt>GUID</dt><dd className="mono small">{selected.guid ?? '—'}</dd>
                  <dt>المُرسِل</dt><dd>{selected.sender_name ?? '—'} {selected.sender_number && <span className="mono">({selected.sender_number})</span>}</dd>
                  <dt>{t('المحفظة المستلِمة', 'Receiving wallet')}</dt><dd className="mono">{selected.receiving_wallet ?? selected.to_account_number ?? '—'}</dd>
                  <dt>البنك / الطريقة</dt><dd>{selected.to_bank ?? '—'} · {selected.payment_method ?? selected.gateway ?? '—'}</dd>
                  <dt>التاجر</dt><dd>{selected.merchant ?? '—'}{selected.sub_merchant && <> · فرعي: {selected.sub_merchant}</>}</dd>
                  <dt>التاجر الرئيسي</dt><dd>{selected.master_merchant ?? '—'}</dd>
                  <dt>NGPay merchant reference</dt><dd className="mono">{selected.merchant_reference ?? selected.merchant_tx_reference ?? '—'}</dd>
                  <dt>الرسوم / العمولة</dt><dd className="mono">{money(selected.fees, selected.currency)} / {money(selected.commission, selected.currency)}</dd>
                  {selected.receiving_wallet && selected.to_account_number && selected.receiving_wallet !== selected.to_account_number && <><dt>{t('المحفظة المخصصة', 'Allocated wallet')}</dt><dd className="mono">{selected.to_account_number}</dd></>}
                  <dt>أول ظهور</dt><dd className="mono">{depositTime({ first_seen_at: selected.first_seen_at })}</dd>
                  <dt>آخر تغيير حالة</dt><dd className="mono">{depositTime({ first_seen_at: selected.last_status_change })}</dd>
                      <dt>اعتمده</dt><dd>{selected.status === 'PENDING' ? '—' : (isAutomaticApprovalActor(selected.approved_by) ? 'آلي (Auto)' : selected.approved_by)}</dd>
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

                {selected.proof_image_url && <ProofIconButton url={selected.proof_image_url} onOpen={setProofUrl} />}

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
                        <div className="timeline-title">{t('القرار', 'Decision')}: {statusMeta(selected.status).label}</div>
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

                {decisionErr && <div className="card warn">{decisionErr}{retryLocked && <div className="cell-sub">{' '}({t('انتظر قليلاً قبل إعادة المحاولة', 'wait a moment before retrying')})</div>}</div>}

                {selected.status === 'PENDING' && can('deposits', 'can_approve') && (
                  <div className="drawer-actions">
                    <button className="btn-primary" disabled={decisionBusy || retryLocked} onClick={() => void decide('approve')}>
                      ✅ اعتماد (PAID)
                    </button>
                    <button className="btn-ghost danger" disabled={decisionBusy || retryLocked} onClick={() => void decide('decline')}>
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
