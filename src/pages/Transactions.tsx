import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import MerchantLogo from '../components/MerchantLogo'
import MethodLogo from '../components/MethodLogo'
import { api, ApiError } from '../lib/api'
import { depositTime, isAutomaticApprovalActor, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'
import ProofModal from '../components/ProofModal'
import SenderIdentity from '../components/SenderIdentity'
import { useAuth } from '../auth/AuthContext'
import { AlertTriangle, CalendarX2, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Eye, Image, LayoutGrid, Pencil, RefreshCw, Search, SlidersHorizontal, TableProperties, X, XCircle } from 'lucide-react'
import TransactionEditDialog from '../components/TransactionEditDialog'
import TransactionDetailModal from '../components/TransactionDetailModal'
import ColumnPicker, { useVisibleColumns } from '../components/ColumnPicker'
import type { ColumnDef } from '../components/ColumnPicker'
import { supabase } from '../lib/supabase'
import { syncProviders } from '../lib/providerSync'
import { useIsMobile } from '../lib/useIsMobile'
import MultiSelectFilter, { splitFilterValues } from '../components/MultiSelectFilter'
import { exportCsv, exportXlsx, type ExportColumn } from '../lib/exportTable'
import { Download } from 'lucide-react'

// All transactions — deposits + payouts merged, sorted by our ref.

const STATUS_FILTERS = ['PENDING', 'PAID', 'APPROVED', 'DECLINED', 'EXPIRED', 'UNDERPAID']

function TransactionStatusIcon({ status, label }: { status: string; label: string }) {
  const Icon = status === 'PENDING'
    ? Clock3
    : status === 'PAID' || status === 'APPROVED'
      ? CheckCircle2
      : status === 'DECLINED'
        ? XCircle
        : status === 'EXPIRED'
          ? CalendarX2
          : status === 'UNDERPAID'
            ? AlertTriangle
            : CircleHelp
  const tone = status === 'PENDING' ? 'st-pending' : status === 'PAID' || status === 'APPROVED' ? 'st-paid' : status === 'DECLINED' ? 'st-declined' : status === 'EXPIRED' ? 'st-expired' : status === 'UNDERPAID' ? 'st-under' : 'st-dim'
  return <span className={`portal-status-icon ${tone}`} title={label} aria-label={label} role="img"><Icon size={21} strokeWidth={2.5} aria-hidden="true" /><span className="portal-status-icon-label">{label}</span></span>
}

// Fixed columns (expand / action / transaction id) always show; everything
// else is opt-in/out via the column picker and persists per browser.
// Keep the operational columns visible on first load. Operators can still
// hide any of them from the column picker; bumping the key makes the denser
// layout apply to existing browsers that saved the previous short set.
const DEFAULT_VISIBLE_COLUMNS = ['status', 'type', 'amount', 'sms_link', 'proof', 'decision_reason', 'client_name', 'client_phone', 'sender_phone_name', 'sender_phone_number', 'email', 'sender_account_name', 'sender_account_number', 'time', 'merchant', 'gateway', 'approved_by']
// v4 resets older browser preferences so the complete 14-column operational
// view is visible after the table-density redesign.
const COLUMNS_STORAGE_KEY = 'trx-visible-columns-v6'

interface TxRow {
  kind: 'deposit' | 'payout'
  tx_id?: number
  maven_id?: number
  ontarget_ref: string | null
  merchant_tx_reference?: string | null
  merchant_reference?: string | null
  status: string
  amount: number | null
  provider_amount?: number | null
  local_amount?: number | null
  amount_sync_status?: 'matched' | 'mismatch' | 'pending_confirmation' | null
  amount_mismatch_reason?: string | null
  settlement_blocked?: boolean | null
  currency?: string | null
  sender_name?: string | null
  sender_number?: string | null
  sender_account_number?: string | null
  sender_account_name?: string | null
  sender_phone_number?: string | null
  sender_phone_name?: string | null
  user_email?: string | null
  account_name?: string | null
  to_account_name?: string | null
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
  decision_reason?: string | null
  decision_actor?: string | null
  first_seen_at: string | null
  created_utc: string | null
  modified_utc?: string | null
  updated_utc?: string | null
  client_transaction_count?: number
  deposit_kind?: 'first_deposit' | 'retention_deposit' | null
  previous_approved_deposits?: number
  matched_sms?: { id: number; received_at: string | null; amount: number | null; balance_after?: number | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; device_name: string | null; sms_first_line: string | null; raw_sms: string | null; raw_payload?: Record<string, unknown> | null; message: string | null; sms_category: string | null; match_status: string | null; matched: boolean | null } | null
  raw_preview?: Record<string, unknown> | null
  is_checkout_session?: boolean
  checkout_session_id?: string
  is_blacklisted?: boolean
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
  const statusValues = splitFilterValues(status)
  const typeValues = splitFilterValues(type)
  // The unified v2 ledger is retained from 2025 onward. Start the home/all-
  // transactions view at that boundary while still allowing operators to
  // change or clear the date filter from the toolbar.
  const from = params.get('from') ?? '2025-01-01'
  const to = params.get('to') ?? ''
  const merchant = params.get('merchant') ?? ''
  const method = params.get('method') ?? ''
  const currency = params.get('currency') ?? ''
  const currencyValues = splitFilterValues(currency)
  const minAmount = params.get('min_amount') ?? ''
  const maxAmount = params.get('max_amount') ?? ''
  const secondaryFilterCount = [from, to, merchant, method, minAmount, maxAmount].filter(Boolean).length + (currencyValues.length > 0 ? 1 : 0)
  const [showMoreFilters, setShowMoreFilters] = useState(() => secondaryFilterCount > 0)
  const isMobile = useIsMobile()
  const viewParam = params.get('view')
  // Absent an explicit choice, a phone opens straight into cards — a data
  // table is a desktop concept — while desktop keeps its table default.
  const view = viewParam === 'cards' ? 'cards' : viewParam === 'table' ? 'table' : isMobile ? 'cards' : 'table'
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const openRef = params.get('open') ?? null
  const [q, setQ] = useState(params.get('q') ?? '')
  const appliedQ = params.get('q') ?? ''
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [proof, setProof] = useState<{ url: string; ref: string; onApprove?: () => void | Promise<void>; onDecline?: () => void | Promise<void> } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const ALL_COLUMNS: ColumnDef[] = [
    { id: 'status', label: t('الحالة', 'Status') },
    { id: 'type', label: t('نوع الدفع', 'Payment Type') },
    { id: 'amount', label: t('المبلغ', 'Amount') },
    { id: 'sms_link', label: t('ربط SMS', 'SMS Link') },
    { id: 'proof', label: t('الإثبات', 'Proof') },
    { id: 'party', label: t('الطرف', 'Party') },
    { id: 'client_name', label: t('اسم العميل', 'Client Name') },
    { id: 'client_phone', label: t('هاتف العميل', 'Client Phone') },
    { id: 'sender_phone_name', label: t('اسم هاتف المرسل', 'Sender Phone Name') },
    { id: 'sender_phone_number', label: t('رقم هاتف المرسل', 'Sender Phone Number') },
    { id: 'email', label: t('بريد المستخدم', 'User Email') },
    { id: 'sender_account_name', label: t('اسم حساب المرسل', 'Sender Account Name') },
    { id: 'sender_account_number', label: t('رقم حساب المرسل', 'Sender Account Number') },
    { id: 'time', label: t('تاريخ الإنشاء UTC', 'Created UTC Date') },
    { id: 'modified_time', label: t('تاريخ التعديل UTC', 'Modified UTC Date') },
    { id: 'to_account_name', label: t('اسم حساب المستلم', 'To Account Name') },
    { id: 'merchant', label: t('التاجر', 'Merchant') },
    { id: 'gateway', label: t('البوابة', 'Gateway') },
    { id: 'duplicates', label: t('التكرار', 'Duplicates') },
    { id: 'approved_by', label: t('اعتمد بواسطة', 'Approved by') },
    { id: 'decision_reason', label: t('سبب القرار', 'Decision reason') },
  ]
  const [visibleCols, setVisibleCols] = useVisibleColumns(COLUMNS_STORAGE_KEY, ALL_COLUMNS.map((c) => c.id), DEFAULT_VISIBLE_COLUMNS)
  const shownColumns = ALL_COLUMNS.filter((c) => visibleCols.has(c.id))

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

  useEffect(() => {
    let alive = true
    // Paint the local mirror immediately. Provider sync can take several
    // seconds and must not block the first page render or a search/filter.
    void load()
    void syncProviders().then((changed) => {
      if (alive && changed) void load(true)
    })
    return () => { alive = false }
  }, [load])

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
    const syncIv = window.setInterval(() => { void syncProviders().then((changed) => { if (changed) schedule() }) }, 10_000)
    return () => {
      abortRef.current?.abort()
      window.clearInterval(syncIv)
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
      void supabase.removeChannel(channel)
    }
  }, [load])

  // Status summary counts (respects the deposit/payout filter, ignores search).
  useEffect(() => {
    const qp = typeValues.length === 1 ? `?type=${typeValues[0]}` : ''
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

  const openDetail = (ref: string) => {
    const p = new URLSearchParams(params)
    p.set('open', ref)
    setParams(p)
  }
  const closeDetail = () => {
    const p = new URLSearchParams(params)
    p.delete('open')
    setParams(p)
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1

  const EXPORT_COLUMNS: ExportColumn<TxRow>[] = [
    { header: 'Ref', key: 'ref', value: (r) => r.ontarget_ref ?? (r.kind === 'deposit' ? r.tx_id : r.maven_id) ?? '' },
    { header: 'Type', key: 'type', value: (r) => r.kind === 'deposit' ? 'Deposit' : 'Payout' },
    { header: 'Status', key: 'status', value: (r) => r.status },
    { header: 'Amount', key: 'amount', value: (r) => r.amount ?? '', numFmt: '#,##0.00' },
    { header: 'Currency', key: 'currency', value: (r) => r.currency ?? 'EGP' },
    { header: 'Party', key: 'party', value: (r) => (r.kind === 'deposit' ? (r.sender_name ?? r.sender_number) : (r.account_name ?? r.mobile_no)) ?? '' },
    { header: 'Party phone', key: 'phone', value: (r) => (r.kind === 'deposit' ? r.sender_number : r.mobile_no) ?? '' },
    { header: 'Sender account name', key: 'sender_account_name', value: (r) => r.sender_account_name ?? '' },
    { header: 'Sender account number', key: 'sender_account_number', value: (r) => r.sender_account_number ?? '' },
    { header: 'Wallet', key: 'wallet', value: (r) => (r.kind === 'deposit' ? (r.to_account_number ?? r.receiving_wallet) : null) ?? '' },
    { header: 'Merchant', key: 'merchant', value: (r) => r.merchant ?? r.master_merchant ?? '' },
    { header: 'Gateway', key: 'gateway', value: (r) => r.gateway ?? '' },
    { header: 'Approved by', key: 'approved_by', value: (r) => r.status === 'PENDING' ? '' : (r.decision_actor ?? (isAutomaticApprovalActor(r.approved_by) ? 'Auto' : r.approved_by ?? '')) },
    { header: 'Created (UTC)', key: 'created', value: (r) => r.created_utc ?? r.first_seen_at ?? '' },
  ]

  // Export respects the active filters, not just the current page — fetch
  // in MAX_PAGE-sized batches up to a sane cap so a huge unfiltered export
  // doesn't hang the browser or the API.
  const EXPORT_CAP = 5000
  const fetchAllForExport = async (): Promise<TxRow[]> => {
    const batchSize = 500
    const collected: TxRow[] = []
    let offset = 0
    for (;;) {
      const search = new URLSearchParams({ limit: String(batchSize), offset: String(offset) })
      if (type) search.set('type', type)
      if (status) search.set('status', status)
      if (appliedQ) search.set('q', appliedQ)
      for (const [key, value] of Object.entries({ from, to, merchant, method, currency, min_amount: minAmount, max_amount: maxAmount })) if (value) search.set(key, value)
      const page = await api<ListResponse>(`/api/transactions?${search}`)
      collected.push(...page.rows)
      offset += batchSize
      if (page.rows.length < batchSize || collected.length >= EXPORT_CAP || offset >= page.total) break
    }
    return collected
  }

  const runExport = async (format: 'csv' | 'xlsx') => {
    setExportBusy(true)
    try {
      const rows = await fetchAllForExport()
      if (format === 'csv') exportCsv(rows, EXPORT_COLUMNS, 'transactions')
      else await exportXlsx(rows, EXPORT_COLUMNS, 'transactions', 'Transactions')
    } catch {
      setErr(t('تعذّر تصدير المعاملات.', 'Failed to export transactions.'))
    } finally {
      setExportBusy(false)
    }
  }

  const toggleExpanded = (key: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const smsAssignHref = (row: TxRow) => {
    const query = new URLSearchParams()
    if (row.amount != null) query.set('amount', String(row.amount))
    const day = row.first_seen_at?.slice(0, 10)
    if (day) { query.set('from', day); query.set('to', day) }
    return `/sms?${query.toString()}`
  }

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

  const refreshNow = async () => {
    setErr(null)
    setLoading(true)
    try {
      await syncProviders()
      await load(true)
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : t('تعذّر تحديث المعاملات.', 'Unable to refresh transactions.'))
    } finally { setLoading(false) }
  }

  return (
    <PanelShell>
      <section className="page-head all-transactions-head">
        <div><h2>📋 {t('كل المعاملات', 'All transactions')}</h2>
        <p className="page-sub">{t('إيداعات وسحوبات موحّدة', 'Deposits and payouts unified')}{data && <> · {data.total.toLocaleString('en-US')}</>}</p></div>
        <div className="all-transactions-head-actions">
          <div className="view-switch" role="group" aria-label={t('طريقة العرض', 'View mode')}>
            <button className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setFilter({ view: 'table' })}><TableProperties size={16} />{t('جدول', 'Table')}</button>
            <button className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => setFilter({ view: 'cards' })}><LayoutGrid size={16} />{t('بطاقات', 'Cards')}</button>
          </div>
          <div className="export-actions">
            <button type="button" className="btn-primary btn-sm" disabled={loading} onClick={() => void refreshNow()}><RefreshCw size={14} className={loading ? 'spin' : ''} /> {loading ? t('جارٍ التحديث…', 'Refreshing…') : t('تحديث الآن', 'Refresh now')}</button>
            <button type="button" className="btn-ghost btn-sm" disabled={exportBusy} onClick={() => void runExport('csv')}><Download size={14}/> CSV</button>
            <button type="button" className="btn-ghost btn-sm" disabled={exportBusy} onClick={() => void runExport('xlsx')}><Download size={14}/> {exportBusy ? t('جارٍ التصدير…', 'Exporting…') : 'XLSX'}</button>
          </div>
        </div>
      </section>

      <div className="filter-bar transaction-filter-toolbar">
        <div className="trx-filter-primary">
          <MultiSelectFilter label={t('نوع المعاملة','Transaction type')} allLabel={t('كل الأنواع','All types')} options={[{value:'deposit',label:t('إيداعات','Deposits')},{value:'payout',label:t('سحوبات','Payouts')}]} value={typeValues} onChange={(values)=>setFilter({type:values.join(',')})}/>
          <MultiSelectFilter label={t('الحالة','Status')} allLabel={t('كل الحالات','All statuses')} options={STATUS_FILTERS.map((value)=>({value,label:statusMeta(value).label,count:counts[value]}))} value={statusValues} onChange={(values)=>setFilter({status:values.join(',')})}/>
          <form className="search-row transaction-search-row trx-search-bar" role="search" onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim() }) }}>
            <Search size={16} aria-hidden="true" />
            <input type="search" className="login-input search-input" aria-label={t('بحث المعاملات', 'Search transactions')} placeholder={t('بحث: مبلغ / مرسل / رقم عملية / مرجع تاجر / مستخدم…', 'Search: amount / sender / transaction / merchant ref / user…')} value={q} onChange={(e) => setQ(e.target.value)} />
            {(q || appliedQ) && <button type="button" className="trx-search-clear" onClick={() => { setQ(''); setFilter({ q: '' }) }} aria-label={t('مسح البحث', 'Clear search')}><X size={15}/></button>}
            <button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>
          </form>
          <button type="button" className={`btn-ghost btn-sm trx-more-filters-toggle${showMoreFilters ? ' active' : ''}`} aria-expanded={showMoreFilters} onClick={() => setShowMoreFilters((v) => !v)}>
            <SlidersHorizontal size={14}/> {t('فلاتر إضافية', 'More filters')}
            {secondaryFilterCount > 0 && <span className="trx-filter-count">{secondaryFilterCount}</span>}
            <ChevronDown size={14} className={showMoreFilters ? 'trx-chevron-open' : ''}/>
          </button>
          {view === 'table' && <ColumnPicker columns={ALL_COLUMNS} visible={visibleCols} onChange={setVisibleCols} label={t('الأعمدة', 'Columns')} />}
          {(secondaryFilterCount > 0 || statusValues.length > 0 || typeValues.length > 0 || appliedQ) && (
            <button className="btn-ghost btn-sm" onClick={() => { setQ(''); setFilter({ from: '', to: '', merchant: '', method: '', currency: '', min_amount: '', max_amount: '', status: '', type: '', q: '' }) }}>{t('مسح الفلاتر', 'Clear filters')}</button>
          )}
        </div>
        {showMoreFilters && (
          <div className="transaction-filter-fields">
            <label className="filter-field">{t('من', 'From')}<input className="login-input" type="date" value={from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
            <label className="filter-field">{t('إلى', 'To')}<input className="login-input" type="date" value={to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
            <label className="filter-field">{t('التاجر', 'Merchant')}<input className="login-input" value={merchant} onChange={(e) => setFilter({ merchant: e.target.value })} /></label>
            <label className="filter-field">{t('الطريقة', 'Method')}<input className="login-input" value={method} onChange={(e) => setFilter({ method: e.target.value })} /></label>
            <MultiSelectFilter label={t('العملة','Currency')} allLabel={t('كل العملات','All currencies')} options={['EGP','USD','USDT'].map((value)=>({value,label:value}))} value={currencyValues} onChange={(values)=>setFilter({currency:values.join(',')})}/>
            <label className="filter-field">{t('أدنى مبلغ', 'Min amount')}<input className="login-input" type="number" min="0" value={minAmount} onChange={(e) => setFilter({ min_amount: e.target.value })} /></label>
            <label className="filter-field">{t('أقصى مبلغ', 'Max amount')}<input className="login-input" type="number" min="0" value={maxAmount} onChange={(e) => setFilter({ max_amount: e.target.value })} /></label>
          </div>
        )}
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
                  {shownColumns.map((c) => <th key={c.id}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const st = statusMeta(r.status)
                  const id = r.kind === 'deposit' ? r.tx_id : r.maven_id
                  const party = r.kind === 'deposit' ? (r.sender_name ?? r.sender_number) : (r.account_name ?? r.mobile_no)
                  const clientPhone = r.kind === 'deposit' ? r.sender_number : r.mobile_no
                  const wallet = r.kind === 'deposit' ? (r.to_account_number ?? r.receiving_wallet) : null
                  const proofUrl = r.kind === 'deposit' ? r.proof_image_url : r.image_url
                  const rowKey = `${r.kind}-${r.checkout_session_id ?? id}`
                  const isExpanded = expanded.has(rowKey)
                  const canOpenModal = r.kind === 'deposit' && !r.is_checkout_session && !!r.ontarget_ref
                  const details = r.is_checkout_session ? `/payment-status?id=${encodeURIComponent(r.checkout_session_id ?? '')}` : r.kind === 'deposit' && r.ontarget_ref ? `/transactions/${encodeURIComponent(r.ontarget_ref)}` : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`
                  const senderAccountName = r.kind === 'deposit' ? (r.sender_account_name ?? r.payment_method ?? party) : (r.account_name ?? party)
                  const cell = (colId: string) => {
                    switch (colId) {
                      case 'status': return <td key={colId}><TransactionStatusIcon status={r.status} label={st.label} /></td>
                      case 'type': return <td key={colId}><div className="portal-method-cell"><MethodLogo method={r.kind === 'deposit' ? r.payment_method : r.pay_by}/><span>{r.kind === 'deposit' ? (r.payment_method ?? t('إيداع', 'Deposit')) : (r.pay_by ?? t('سحب', 'Payout'))}</span></div></td>
                      case 'amount': return (
                        <td key={colId} className="mono portal-amount-cell">
                          {money(r.amount, r.currency ?? 'EGP')}
                          {r.amount_sync_status === 'mismatch' && <div className="amount-critical-warning" title={r.amount_mismatch_reason ?? 'Maven amount confirmation required'}>⚠ CRITICAL</div>}
                        </td>
                      )
                      case 'sms_link': return <td key={colId}>{r.kind === 'deposit' && r.matched_sms
                        ? <button type="button" className={`tx-sms-chip ${r.status === 'DECLINED' ? 'is-warning' : 'is-matched'}`} onClick={() => toggleExpanded(rowKey)} title={`${r.matched_sms.sender_name ?? r.matched_sms.sender_number ?? '—'} · ${money(r.matched_sms.amount, r.currency ?? 'EGP')}`}>{r.status === 'DECLINED' ? <AlertTriangle size={11} aria-hidden="true" /> : '📨'} #{r.matched_sms.id}</button>
                        : <button type="button" className="tx-sms-chip is-missing" onClick={() => toggleExpanded(rowKey)}>{t('غير مرتبط', 'Not linked')}</button>}</td>
                      case 'proof': return <td key={colId}>{proofUrl
                        ? <button type="button" className="tx-proof-icon" onClick={() => setProof({ url: proofUrl, ref: String(r.ontarget_ref ?? id), onApprove: r.status === 'PENDING' && r.kind === 'deposit' && !r.is_checkout_session && can('deposits', 'can_approve') ? async () => { await decide(r, 'approve'); setProof(null) } : undefined, onDecline: r.status === 'PENDING' && r.kind === 'deposit' && !r.is_checkout_session && can('deposits', 'can_approve') ? async () => { await decide(r, 'decline'); setProof(null) } : undefined })} aria-label={t('عرض الإثبات', 'View proof')} title={t('عرض الإثبات', 'View proof')}><Image size={14}/></button>
                        : <span className="tx-proof-empty" title={t('لا يوجد إثبات', 'No proof')}>—</span>}</td>
                      case 'party': return <td key={colId}><SenderIdentity name={party} phone={clientPhone} nameHref={party ? `/transactions?q=${encodeURIComponent(party)}` : undefined} phoneHref={clientPhone ? `/client/${encodeURIComponent(clientPhone)}` : undefined}/></td>
                      case 'client_name': return <td key={colId}>{party ?? '—'}</td>
                      case 'client_phone': return <td key={colId} className="mono">{clientPhone ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone)}`}>{clientPhone}</Link> : '—'}</td>
                      case 'sender_phone_name': return <td key={colId}>{r.sender_phone_name ?? r.sender_name ?? '—'}</td>
                      case 'sender_phone_number': return <td key={colId} className="mono">{r.sender_phone_number ?? r.sender_number ?? '—'}</td>
                      case 'email': return <td key={colId}>{r.user_email ? <a href={`mailto:${r.user_email}`} className="transaction-cell-link">{r.user_email}</a> : '—'}</td>
                      case 'sender_account_name': return <td key={colId}>{senderAccountName ?? '—'}</td>
                      case 'sender_account_number': return <td key={colId} className="mono"><Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(r.sender_account_number ?? clientPhone ?? '')}`}>{r.sender_account_number ?? clientPhone ?? '—'}</Link></td>
                      case 'time': return <td key={colId} className="mono">{depositTime(r)}</td>
                      case 'modified_time': return <td key={colId} className="mono">{depositTime({ created_utc: r.kind === 'deposit' ? r.modified_utc : r.updated_utc })}</td>
                      case 'to_account_name': return <td key={colId}>{(r.kind === 'deposit' ? r.to_account_name : null) ?? '—'}</td>
                      case 'merchant': return <td key={colId}><MerchantLogo merchant={r.merchant ?? r.master_merchant}/></td>
                      case 'gateway': return <td key={colId} className="mono">{r.gateway ?? '—'}</td>
                      case 'duplicates': return <td key={colId}>{(r.client_transaction_count ?? 1) > 1 ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات', 'transactions')}</Link> : t('أول معاملة', 'First transaction')}</td>
                      case 'approved_by': return <td key={colId}>{r.status === 'PENDING' ? '—' : (r.decision_actor ?? (isAutomaticApprovalActor(r.approved_by) ? t('آلي (Auto)', 'Auto') : r.approved_by))}</td>
                      case 'decision_reason': return <td key={colId} className={`decision-reason-cell ${r.status === 'DECLINED' ? 'is-declined' : r.status === 'PAID' || r.status === 'APPROVED' ? 'is-approved' : ''}`} title={r.decision_reason ?? undefined}>{r.decision_reason ?? (r.status === 'DECLINED' ? t('مرفوض — السبب غير مسجل', 'Declined — reason not recorded') : r.status === 'PAID' || r.status === 'APPROVED' ? t('تمت الموافقة', 'Approved') : '—')}</td>
                      default: return null
                    }
                  }
                  return (
                    <Fragment key={rowKey}>
                        <tr key={rowKey} className={`${r.status === 'PENDING' ? 'row-pending ' : ''}${r.matched_sms?.match_status === 'auto_review' ? (r.kind === 'payout' ? 'sms-review-neon-out' : 'sms-review-neon-in') : ''}`}>
                        <td><button type="button" className="tx-expand-btn" onClick={() => toggleExpanded(rowKey)} aria-expanded={isExpanded} aria-label={isExpanded ? t('إغلاق التفاصيل', 'Collapse details') : t('فتح التفاصيل', 'Expand details')}>{isExpanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}</button></td>
                        <td><div className="portal-row-actions">{canOpenModal ? <button type="button" className="tx-action-primary tx-action-icon" onClick={() => openDetail(r.ontarget_ref!)} title={r.status === 'PENDING' ? t('تعديل المعاملة', 'Edit transaction') : t('عرض المعاملة', 'View transaction')} aria-label={r.status === 'PENDING' ? t('تعديل المعاملة', 'Edit transaction') : t('عرض المعاملة', 'View transaction')}>{r.status === 'PENDING' ? <Pencil size={17}/> : <Eye size={17}/>}</button> : <Link className="tx-action-primary tx-action-icon" to={details} title={r.status === 'PENDING' ? t('تعديل المعاملة', 'Edit transaction') : t('عرض المعاملة', 'View transaction')} aria-label={r.status === 'PENDING' ? t('تعديل المعاملة', 'Edit transaction') : t('عرض المعاملة', 'View transaction')}>{r.status === 'PENDING' ? <Pencil size={17}/> : <Eye size={17}/>}</Link>}{id && (r.kind === 'deposit' ? <TransactionEditDialog iconOnly txId={Number(id)} ontargetRef={r.ontarget_ref} status={r.status} amount={r.amount} currency={r.currency} gateway={r.gateway} currentReceivingWallet={r.to_account_number ?? r.receiving_wallet} onDone={() => void load()} /> : <Link className="btn-ghost btn-sm tx-action-icon" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}&edit=1`} title={t('تعديل المعاملة', 'Edit transaction')} aria-label={t('تعديل المعاملة', 'Edit transaction')}><Pencil size={17}/></Link>)}{proofUrl && <button type="button" className="tx-proof-icon tx-action-icon" onClick={() => setProof({ url: proofUrl, ref: String(r.ontarget_ref ?? id), onApprove: r.status === 'PENDING' && r.kind === 'deposit' && !r.is_checkout_session && can('deposits', 'can_approve') ? async () => { await decide(r, 'approve'); setProof(null) } : undefined, onDecline: r.status === 'PENDING' && r.kind === 'deposit' && !r.is_checkout_session && can('deposits', 'can_approve') ? async () => { await decide(r, 'decline'); setProof(null) } : undefined })} aria-label={t('عرض الإثبات', 'View proof')} title={t('عرض الإثبات', 'View proof')}><Image size={17}/></button>}</div></td>
                        <td className="mono">{canOpenModal ? <button type="button" className="transaction-cell-link tx-id-link" onClick={() => openDetail(r.ontarget_ref!)}>{id}</button> : <Link className="transaction-cell-link" to={details}>{r.is_checkout_session ? r.ontarget_ref : id}</Link>}{r.is_blacklisted && <span className="blacklist-marker" title={t('رقم الهاتف محظور — رفض تلقائي', 'Phone blacklisted — auto-decline')} aria-label={t('رقم الهاتف محظور', 'Phone blacklisted')}>🚫</span>}{r.is_checkout_session && <span className="deposit-kind is-first">🔗 Payment link</span>}{!r.is_checkout_session && r.ontarget_ref && String(r.ontarget_ref) !== String(id) && <div className="cell-sub mono">{r.ontarget_ref}</div>}{(r.merchant_reference ?? r.merchant_tx_reference) && <div className="cell-sub mono" title="NGPay merchant reference">{r.merchant_reference ?? r.merchant_tx_reference}</div>}{r.kind === 'deposit' && !r.is_checkout_session && <span className={`deposit-kind ${r.deposit_kind === 'retention_deposit' ? 'is-retention' : 'is-first'}`}>{r.deposit_kind === 'retention_deposit' ? `↻ ${t('Retention','Retention')}` : `★ ${t('First','First')}`}</span>}</td>
                        {shownColumns.map((c) => cell(c.id))}
                      </tr>
                      {isExpanded && <tr key={`${rowKey}-details`} className="tx-expanded-row"><td colSpan={3 + shownColumns.length}><div className="tx-expanded-split">
                      <div className="tx-expanded-table-side">
                      <div className="tx-expanded-grid">
                        <div><span>{t('بريد المستخدم', 'User email')}</span>{r.user_email ? <a href={`mailto:${r.user_email}`} className="transaction-cell-link">{r.user_email}</a> : '—'}</div>
                        <div><span>{t('اسم حساب المرسل', 'Sender account name')}</span>{senderAccountName ?? '—'}</div>
                        <div><span>{t('رقم حساب المرسل', 'Sender account number')}</span><Link className="mono transaction-cell-link" to={`/transactions?q=${encodeURIComponent(r.sender_account_number ?? clientPhone ?? '')}`}>{r.sender_account_number ?? clientPhone ?? '—'}</Link></div>
                        <div><span>{t('المحفظة المستلمة', 'Receiving wallet')}</span>{wallet ? <Link className="mono transaction-cell-link" to={`/transactions?type=deposit&q=${encodeURIComponent(wallet)}`}>{wallet}</Link> : '—'}</div>
                        <div><span>{t('التاجر', 'Merchant')}</span><MerchantLogo merchant={r.merchant ?? r.master_merchant}/></div>
                        <div><span>{t('البوابة', 'Gateway')}</span><strong>{r.gateway ?? '—'}</strong></div>
                        <div><span>{t('التكرار', 'Duplicates')}</span>{(r.client_transaction_count ?? 1) > 1 ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات', 'transactions')}</Link> : t('أول معاملة', 'First transaction')}</div>
                        <div><span>{t('اعتمد بواسطة', 'Approved by')}</span><strong>{r.status === 'PENDING' ? '—' : (r.decision_actor ?? (isAutomaticApprovalActor(r.approved_by) ? t('آلي (Auto)', 'Auto') : r.approved_by))}</strong></div>
                      </div>
                      <div className="tx-expanded-actions">{r.status === 'PENDING' && !r.is_checkout_session && r.kind === 'deposit' && can('deposits','can_approve') && <><button className="btn-primary btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r,'approve')}>{t('اعتماد', 'Approve')}</button><button className="btn-ghost btn-sm danger" disabled={actionBusy !== null} onClick={() => void decide(r,'decline')}>{t('رفض', 'Reject')}</button></>}{r.status === 'PENDING' && r.kind === 'payout' && can('payouts','can_approve') && <><Link className="btn-primary btn-sm" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}>{t('إثبات ودفع', 'Proof & Pay')}</Link><button className="btn-ghost btn-sm danger" disabled={actionBusy !== null} onClick={() => void decide(r,'decline')}>{t('رفض', 'Reject')}</button></>}{r.kind === 'deposit' && r.status === 'DECLINED' && !r.matched_sms && can('sms_live','can_edit') && <Link className="btn-ghost btn-sm danger" to={smsAssignHref(r)}>🔗✅ {t('ربط واعتماد SMS', 'Link & approve SMS')}</Link>}{r.is_checkout_session && <span className="cell-sub">{t('جلسة رابط دفع — بانتظار ظهور المعاملة المزوّدة', 'Payment-link session — waiting for provider transaction')}</span>}</div>
                      <details className="tx-raw-details"><summary>{t('عرض تفاصيل Raw', 'View raw details')}</summary>{r.raw_preview ? <pre>{JSON.stringify(r.raw_preview, null, 2)}</pre> : <p className="cell-sub">{t('لا تتوفر بيانات Raw لهذا الصف.', 'Raw data is not available for this row.')}</p>}</details>
                      </div>
                      <div className="tx-expanded-sms-side">
                        <span className="tx-expanded-sms-side-title">{t('دليل SMS', 'SMS evidence')}</span>
                        {r.kind === 'deposit' ? (r.matched_sms ? <div className="tx-sms-raw">{r.status === 'DECLINED' ? <span className="tx-sms-label tx-sms-warning-label"><AlertTriangle size={13} aria-hidden="true" /> SMS مع مرفوضة</span> : <span className="tx-sms-label">📨 SMS الخاص بالمعاملة</span>}<span className="mono">#{r.matched_sms.id}</span><span>{r.matched_sms.sender_name ?? r.matched_sms.sender_number ?? '—'} → {r.matched_sms.receiver_number ?? '—'}</span><span className="mono">{money(r.matched_sms.amount, r.currency ?? 'EGP')}</span>{r.matched_sms.balance_after != null && <strong className="tx-live-balance mono">رصيدك الحالي {money(r.matched_sms.balance_after, r.currency ?? 'EGP')}</strong>}<code className={r.status === 'DECLINED' ? 'is-warning-raw' : undefined}>{r.matched_sms.raw_sms ?? r.matched_sms.message ?? r.matched_sms.sms_first_line ?? '—'}</code></div> : <div className="tx-sms-raw is-missing"><strong>{t('لا توجد رسالة SMS مرتبطة', 'No SMS linked')}</strong><Link to={`/sms?amount=${r.amount ?? ''}`}>{t('البحث عن رسالة', 'Search SMS')}</Link></div>) : <div className="tx-sms-raw is-missing"><strong>{t('لا ينطبق على السحوبات', 'Not applicable to payouts')}</strong></div>}
                      </div></div>
                      </td></tr>}
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
              const wallet = r.kind === 'deposit' ? (r.to_account_number ?? r.receiving_wallet) : null
              const proofUrl = r.kind === 'deposit' ? r.proof_image_url : r.image_url
              const canOpenModal = r.kind === 'deposit' && !r.is_checkout_session && !!r.ontarget_ref
              const details = r.is_checkout_session ? `/payment-status?id=${encodeURIComponent(r.checkout_session_id ?? '')}` : r.kind === 'deposit' && r.ontarget_ref ? `/transactions/${encodeURIComponent(r.ontarget_ref)}` : `/${r.kind === 'deposit' ? 'deposits' : 'payouts'}?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`
              return <article key={`${r.kind}-${r.checkout_session_id ?? id}`} className={`all-tx-card${r.status === 'PENDING' ? ' pending' : ''}`}>
                <header>{canOpenModal ? <button type="button" className="mono transaction-cell-link tx-id-link" onClick={() => openDetail(r.ontarget_ref!)}>{r.ontarget_ref}</button> : <Link className="mono transaction-cell-link" to={details}>{r.ontarget_ref ?? id}</Link>}{r.is_blacklisted && <span className="blacklist-marker" title={t('رقم الهاتف محظور — رفض تلقائي', 'Phone blacklisted — auto-decline')} aria-label={t('رقم الهاتف محظور', 'Phone blacklisted')}>🚫</span>}<span className={`pay-status-badge ${st.cls}`}>{st.label}</span></header>
                <div className="all-tx-card-amount mono">
                  {money(r.amount, r.currency ?? 'EGP')}
                  {r.amount_sync_status === 'mismatch' && <div className="amount-critical-warning" title={r.amount_mismatch_reason ?? 'Maven amount confirmation required'}>⚠ CRITICAL</div>}
                  {r.kind === 'deposit' && (r.matched_sms
                    ? <span className={`tx-sms-chip ${r.status === 'DECLINED' ? 'is-warning' : 'is-matched'}`} title={`${r.matched_sms.sender_name ?? r.matched_sms.sender_number ?? '—'} · ${money(r.matched_sms.amount, r.currency ?? 'EGP')}`}>{r.status === 'DECLINED' ? <AlertTriangle size={11} aria-hidden="true" /> : '📨'} SMS</span>
                    : <span className="tx-sms-chip is-missing">{t('بدون SMS', 'No SMS')}</span>)}
                </div>
                {r.kind === 'deposit' && r.matched_sms?.balance_after != null && <div className="tx-live-balance mono">رصيدك الحالي {money(r.matched_sms.balance_after, r.currency ?? 'EGP')}</div>}
                {proofUrl && <button type="button" className="all-tx-card-proof" onClick={() => setProof({ url: proofUrl, ref: String(r.ontarget_ref ?? id), onApprove: r.status === 'PENDING' && r.kind === 'deposit' && !r.is_checkout_session && can('deposits', 'can_approve') ? async () => { await decide(r, 'approve'); setProof(null) } : undefined, onDecline: r.status === 'PENDING' && r.kind === 'deposit' && !r.is_checkout_session && can('deposits', 'can_approve') ? async () => { await decide(r, 'decline'); setProof(null) } : undefined })}><img src={proofUrl} alt="" loading="lazy" /><span>{t('عرض إثبات الدفع', 'View payment proof')}</span></button>}
                <div className="all-tx-card-brands"><MerchantLogo merchant={r.merchant ?? r.master_merchant} /><MethodLogo method={r.kind === 'deposit' ? r.payment_method : r.pay_by} /></div>
                <dl>
                  <div><dt>{t('النوع', 'Type')}</dt><dd>{r.kind === 'deposit' ? t('إيداع', 'Deposit') : t('سحب', 'Payout')}</dd></div>
                  <div><dt>{t('الطرف', 'Party')}</dt><dd><SenderIdentity name={party} phone={clientPhone} nameHref={party ? `/transactions?q=${encodeURIComponent(party)}` : undefined} phoneHref={clientPhone ? `/client/${encodeURIComponent(clientPhone)}` : undefined} /></dd></div>
                  <div><dt>{t('حساب المرسل', 'Sender account')}</dt><dd className="mono">{r.kind === 'deposit' ? (r.sender_account_number ?? r.sender_number ?? '—') : '—'}</dd></div>
                  <div><dt>{t('المحفظة', 'Wallet')}</dt><dd className="mono">{wallet ?? '—'}</dd></div>
                  <div><dt>{t('نوع الإيداع', 'Deposit type')}</dt><dd>{r.kind === 'deposit' ? <span className={`deposit-kind ${r.deposit_kind === 'retention_deposit' ? 'is-retention' : 'is-first'}`}>{r.deposit_kind === 'retention_deposit' ? `↻ ${t('Retention deposit','Retention deposit')}` : `★ ${t('First deposit','First deposit')}`}</span> : '—'}</dd></div>
                  <div><dt>{t('التكرار', 'Duplicates')}</dt><dd>{(r.client_transaction_count ?? 1) > 1 ? <Link className="transaction-cell-link" to={`/transactions?q=${encodeURIComponent(clientPhone ?? party ?? '')}`}>{r.client_transaction_count} {t('معاملات', 'transactions')}</Link> : t('أول معاملة', 'First')}</dd></div>
                  <div><dt>{t('اعتمد بواسطة', 'Approved by')}</dt><dd>{r.status === 'PENDING' ? '—' : (r.decision_actor ?? (isAutomaticApprovalActor(r.approved_by) ? t('آلي (Auto)', 'Auto') : r.approved_by))}</dd></div>
                  <div><dt>{t('الوقت', 'Time')}</dt><dd className="mono">{depositTime(r)}</dd></div>
                </dl>
                <div className="all-tx-card-actions">
                  {id && (r.kind === 'deposit' ? <TransactionEditDialog txId={Number(id)} ontargetRef={r.ontarget_ref} status={r.status} amount={r.amount} currency={r.currency} gateway={r.gateway} currentReceivingWallet={r.to_account_number ?? r.receiving_wallet} onDone={() => void load()} /> : <Link className="btn-ghost btn-sm" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}&edit=1`}><Pencil size={13}/> {t('تعديل', 'Edit')}</Link>)}
                  {r.status === 'PENDING' && !r.is_checkout_session && r.kind === 'deposit' && can('deposits', 'can_approve') && <><button className="btn-primary btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'approve')}>{t('اعتماد', 'Approve')}</button><button className="btn-ghost danger btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'decline')}>{t('رفض', 'Reject')}</button></>}
                  {r.kind === 'deposit' && r.status === 'DECLINED' && !r.matched_sms && can('sms_live','can_edit') && <Link className="btn-ghost btn-sm" to={smsAssignHref(r)}>🔗 {t('تعيين SMS', 'Assign SMS')}</Link>}
                  {r.status === 'PENDING' && r.kind === 'payout' && can('payouts', 'can_approve') && <><Link className="btn-primary btn-sm" to={`/payouts?q=${encodeURIComponent(r.ontarget_ref ?? String(id))}`}>{t('إثبات ودفع', 'Proof & Pay')}</Link><button className="btn-ghost danger btn-sm" disabled={actionBusy !== null} onClick={() => void decide(r, 'decline')}>{t('رفض', 'Reject')}</button></>}
                  {canOpenModal ? <button type="button" className="btn-ghost btn-sm" onClick={() => openDetail(r.ontarget_ref!)}>{t('التفاصيل', 'Details')}</button> : <Link className="btn-ghost btn-sm" to={details}>{t('التفاصيل', 'Details')}</Link>}
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
      {proof && <ProofModal url={proof.url} title={`${t('إثبات الدفع', 'Payment proof')} · ${proof.ref}`} onClose={() => setProof(null)} actionBusy={actionBusy !== null} onApprove={proof.onApprove} onDecline={proof.onDecline} />}
      {openRef && <TransactionDetailModal txRef={openRef} onClose={closeDetail} onChanged={() => void load(true)} />}
    </PanelShell>
  )
}
