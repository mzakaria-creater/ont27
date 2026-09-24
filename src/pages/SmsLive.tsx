import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { usePageSize } from '../lib/pageSize'
import PageSizeSelect from '../components/PageSizeSelect'
import { LayoutGrid, TableProperties, X } from 'lucide-react'
import MethodLogo from '../components/MethodLogo'
import MultiSelectFilter, { splitFilterValues } from '../components/MultiSelectFilter'

// SMS Live — the inbound_sms queue with its Maven links, auto-refreshing.

const REFRESH_MS = 8_000

const CATEGORY_META: Record<string, { ar: string; en: string; cls: string }> = {
  deposit: { ar: 'إيداع', en: 'Deposit', cls: 'st-paid' },
  withdrawal: { ar: 'سحب', en: 'Withdrawal', cls: 'st-declined' },
  balance: { ar: 'رصيد', en: 'Balance', cls: 'st-dim' },
  otp: { ar: 'OTP', en: 'OTP', cls: 'st-dim' },
  promotion: { ar: 'دعاية', en: 'Promo', cls: 'st-dim' },
  smslive: { ar: 'SMS مباشر', en: 'SMS Live', cls: 'st-paid' },
  unknown: { ar: 'غير معروف', en: 'Unknown', cls: 'st-under' },
}

const MATCH_META: Record<string, { ar: string; en: string; cls: string }> = {
  auto: { ar: 'مرتبطة (آلي)', en: 'Linked (auto)', cls: 'st-paid' },
  manual: { ar: 'مرتبطة (يدوي)', en: 'Linked (manual)', cls: 'st-paid' },
  matched_paid: { ar: 'مرتبطة ومدفوعة', en: 'Linked & paid', cls: 'st-paid' },
  unmatched: { ar: 'غير مرتبطة', en: 'Unlinked', cls: 'st-dim' },
}

const MATCH_FILTERS = [
  { key: 'linked', ar: 'مرتبطة', en: 'Linked' },
  { key: 'unmatched', ar: 'غير مرتبطة', en: 'Unlinked' },
  { key: 'review', ar: 'تحتاج مراجعة', en: 'Needs review' },
]

// Same 5 channels + grouping MethodLogo already uses for the per-row icon —
// server-side matching (applySmsFilters) mirrors these exact keys.
const PROVIDER_FILTERS = [
  { key: 'orange_cash', ar: 'أورانج كاش', en: 'Orange Cash' },
  { key: 'vodafone_cash', ar: 'فودافون كاش', en: 'Vodafone Cash' },
  { key: 'we_pay', ar: 'وي باي', en: 'WE Pay' },
  { key: 'instapay', ar: 'إنستاباي', en: 'InstaPay' },
  { key: 'alex_bank', ar: 'بنك الإسكندرية', en: 'Alex Bank' },
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
  is_blocked: boolean | null
  block_reason: string | null
  blocked_at: string | null
  blocked_by: string | null
  assignment_unlocked_at?: string | null
  assignment_unlocked_by?: string | null
  trx_id: string | null
  matched_transaction_id: number | null
  maven_transaction_id: string | null
  consumed_by_tx_id: number | null
  wallet_number: string | null
  confirmed_wallet_number: string | null
  wallet_identity_ambiguous?: boolean
  linked_wallet_number?: string | null
  wallet_balance_before?: number | null
  wallet_balance_after?: number | null
  matched_tx_id?: number | null
  matched_ontarget_ref?: string | null
  matched_payout_id?: number | null
  matched_payout_ref?: string | null
  matched_payout_status?: string | null
  matched_currency?: string | null
  matched_sub_merchant?: string | null
  matched_master_merchant?: string | null
  matched_gateway?: string | null
  matched_receiving_wallet?: string | null
  wallet_match?: boolean | null
  withdrawal_assignment_type?: 'payout' | 'p2p_usdt' | 'cash_return' | 'mina_cash' | null
  withdrawal_assignment_reference?: string | null
  withdrawal_assignment_name?: string | null
  withdrawal_assigned_by?: string | null
  withdrawal_assigned_at?: string | null
  provider: string | null
  sms_first_line: string | null
  raw_sms?: string | null
  sms_sender?: string | null
  raw_payload?: Record<string, unknown> | null
  webhook_name?: string | null
  webhook_address?: string | null
  method?: string | null
  ocr_text?: string | null
  score?: number | null
  auto_match_score?: number | null
  processed_at?: string | null
  maven_synced?: boolean | null
  maven_synced_at?: string | null
  maven_status_sent?: string | null
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

function displayWalletForRow(row: SmsRow): string | null {
  // After linking, the transaction's current allocation is the operational
  // wallet. The raw SMS wallet remains available as evidence, but may be an
  // older number after Maven wallet rotation.
  if (row.matched_tx_id != null && row.matched_receiving_wallet) return row.matched_receiving_wallet
  return row.wallet_identity_ambiguous ? null : row.confirmed_wallet_number ?? row.wallet_number ?? row.receiver_number
}

interface SmsStats {
  total: number
  deposits: { count: number; dayVolume: number }
  withdrawals: { count: number; dayVolume: number }
  linked: number
  review: number
}

interface WalletPaidTotal { wallet: string; paid_amount: number; transaction_ref?: string | null; merchant?: string | null }

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
  sub_merchant?: string | null
  master_merchant?: string | null
  gateway?: string | null
  receiving_wallet?: string | null
  to_account_number?: string | null
  first_seen_at: string | null
  seconds_diff?: number | null
  is_duplicate_group?: boolean
}

function firstLine(r: SmsRow): string {
  const raw = r.sms_first_line ?? ''
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('From :'))[0]
  return line ?? '—'
}

function payloadValue(row: SmsDetail, keys: string[]): unknown {
  const payload = row.raw_payload
  if (!payload || typeof payload !== 'object') return null
  const wanted = keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''))
  const entry = Object.entries(payload).find(([key, value]) => value != null && wanted.includes(key.toLowerCase().replace(/[^a-z0-9]/g, '')))
  return entry?.[1] ?? null
}

function displayValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function smsReport(row: SmsDetail) {
  const raw = row.raw_sms ?? row.message ?? row.sms_first_line ?? ''
  const phone = raw.match(/(?:01\d{9}|2?01\d{9})/)?.[0] ?? row.sender_number ?? null
  const ref = raw.match(/(?:رقم\s*(?:ال)?(?:عملية|المعاملة)|transaction\s*(?:id|number))\s*[:#]?\s*([A-Za-z0-9-]+)/i)?.[1] ?? row.trx_id ?? null
  const amount = row.amount ?? (Number(raw.match(/(?:مبلغ|amount)\s*[:：]?\s*([\d,.]+)/i)?.[1]?.replace(/,/g, '')) || null)
  const balance = row.balance_after ?? (Number(raw.match(/(?:رصيدك|الرصيد|balance)[^\d]*([\d,.]+)/i)?.[1]?.replace(/,/g, '')) || null)
  return {
    amount: Number.isFinite(amount as number) ? amount : null,
    balance: Number.isFinite(balance as number) ? balance : null,
    phone,
    ref,
    provider: row.provider ?? row.sms_sender ?? 'SMS',
    time: row.received_at ? new Date(row.received_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—',
    date: row.received_at ? new Date(row.received_at).toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—',
  }
}

export default function SmsLive() {
  const [pageSize, setPageSize] = usePageSize('sms')
  const { can } = useAuth()
  const { t } = useLocale()
  const [params, setParams] = useSearchParams()
  const category = params.get('category') ?? ''
  const categoryValues = splitFilterValues(category)
  const provider = params.get('provider') ?? ''
  const providerValues = splitFilterValues(provider)
  const match = params.get('match') ?? ''
  const page = Math.max(Number(params.get('page')) || 1, 1)
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const [q, setQ] = useState(params.get('q') ?? '')
  const [amountQ, setAmountQ] = useState(params.get('amount') ?? '')
  const [data, setData] = useState<ListResponse | null>(null)
  const [stats, setStats] = useState<SmsStats | null>(null)
  const [walletPaidTotals, setWalletPaidTotals] = useState<WalletPaidTotal[]>([])
  const [walletAlertDismissed, setWalletAlertDismissed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<SmsDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [candidates, setCandidates] = useState<CandidateTx[] | null>(null)
  const [candQ, setCandQ] = useState('')
  const [candLoading, setCandLoading] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkErr, setLinkErr] = useState<string | null>(null)
  const [quickLinkRow, setQuickLinkRow] = useState<SmsRow | null>(null)
  const [quickLinkQuery, setQuickLinkQuery] = useState('')
  const [quickLinkCandidates, setQuickLinkCandidates] = useState<CandidateTx[] | null>(null)
  const [quickLinkLoading, setQuickLinkLoading] = useState(false)
  const [quickLinkBusy, setQuickLinkBusy] = useState(false)
  const [quickLinkError, setQuickLinkError] = useState<string | null>(null)
  const [metaName, setMetaName] = useState('')
  const [metaNotes, setMetaNotes] = useState('')
  const [metaCategory, setMetaCategory] = useState('')
  const [metaWallet, setMetaWallet] = useState('')
  const [metaBusy, setMetaBusy] = useState(false)
  const [assignmentType, setAssignmentType] = useState<'payout' | 'p2p_usdt' | 'cash_return' | 'mina_cash'>('payout')
  const [assignmentRef, setAssignmentRef] = useState('')
  const [assignmentName, setAssignmentName] = useState('')
  const [assignmentBusy, setAssignmentBusy] = useState(false)
  const [expenseComment, setExpenseComment] = useState('')
  const [expenseBusy, setExpenseBusy] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualBusy, setManualBusy] = useState(false)
  const [manualForm, setManualForm] = useState({ message: '', sms_category: 'deposit', amount: '', sender_name: '', sender_number: '', receiver_number: '', trx_id: '', received_at: '', note: '' })
  // Respect an explicit prior choice either way; absent one, a phone opens
  // straight into the card view (a data table is a desktop concept — nobody
  // wants to pan a wide grid sideways on a 6" screen) while desktop keeps
  // defaulting to the table it always has.
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(() => {
    const saved = localStorage.getItem('sms-live-view')
    if (saved === 'cards' || saved === 'table') return saved
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches ? 'cards' : 'table'
  })

  const appliedQ = params.get('q') ?? ''
  const amount = params.get('amount') ?? ''
  const requestedSmsId = Number(params.get('sms_id'))

  const submitManual = async (event: FormEvent) => {
    event.preventDefault()
    if (!manualForm.message.trim()) return
    setManualBusy(true); setErr(null)
    try {
      await api('/api/sms/manual', { method: 'POST', body: JSON.stringify({ ...manualForm, amount: manualForm.amount || null, received_at: manualForm.received_at ? new Date(manualForm.received_at).toISOString() : null }) })
      setManualForm({ message: '', sms_category: 'deposit', amount: '', sender_name: '', sender_number: '', receiver_number: '', trx_id: '', received_at: '', note: '' })
      setManualOpen(false)
      await load()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('تعذر حفظ SMS اليدوية.', 'Could not save manual SMS.'))
    } finally { setManualBusy(false) }
  }

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const search = new URLSearchParams({
      limit: String(pageSize),
      offset: String((page - 1) * pageSize),
    })
    if (category) search.set('category', category)
    if (provider) search.set('provider', provider)
    if (match) search.set('match', match)
    if (appliedQ) search.set('q', appliedQ)
    if (amount) search.set('amount', amount)
    if (from) search.set('from', from)
    if (to) search.set('to', to)
    try {
      const [list, st, walletTotals] = await Promise.all([
        api<ListResponse>(`/api/sms?${search}`),
        api<SmsStats>(`/api/sms/stats?${search}`),
        api<{ rows: WalletPaidTotal[] }>('/api/wallet-paid-totals'),
      ])
      setData((current) => JSON.stringify(current) === JSON.stringify(list) ? current : list)
      setStats(st)
      setWalletPaidTotals(walletTotals.rows ?? [])
      if (!(walletTotals.rows ?? []).some((row) => row.paid_amount >= 50_000)) setWalletAlertDismissed(false)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض رسائل SMS.', 'You do not have permission to view SMS.') : t('تعذّر تحميل الرسائل.', 'Failed to load messages.'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [category, provider, match, appliedQ, amount, from, to, page, pageSize])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const iv = setInterval(() => void load(true), REFRESH_MS)
    return () => clearInterval(iv)
  }, [load])

  const setFilter = (next: { category?: string; provider?: string; match?: string; q?: string; amount?: string; from?: string; to?: string; page?: number }) => {
    const p = new URLSearchParams(params)
    const setOrDel = (key: string, v: string | undefined) => {
      if (v === undefined) return
      if (v) p.set(key, v); else p.delete(key)
      p.delete('page')
    }
    setOrDel('category', next.category)
    setOrDel('provider', next.provider)
    setOrDel('match', next.match)
    setOrDel('q', next.q)
    setOrDel('amount', next.amount)
    setOrDel('from', next.from)
    setOrDel('to', next.to)
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

  // Quick-link from a card: pick a transaction without opening the full
  // detail drawer. Deposit SMS only — withdrawal assignment needs the
  // drawer's extra fields (assignment type, wallet, name).
  const loadQuickLinkCandidates = async (id: number, search?: string) => {
    setQuickLinkLoading(true)
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : ''
      const res = await api<{ candidates: CandidateTx[] }>(`/api/sms/${id}/candidates${qs}`)
      setQuickLinkCandidates(res.candidates)
    } catch {
      setQuickLinkCandidates([])
    } finally {
      setQuickLinkLoading(false)
    }
  }
  const openQuickLink = (row: SmsRow) => {
    setQuickLinkRow(row); setQuickLinkQuery(''); setQuickLinkCandidates(null); setQuickLinkError(null)
    void loadQuickLinkCandidates(row.id)
  }
  const submitQuickLink = async (txId: number) => {
    if (!quickLinkRow) return
    setQuickLinkBusy(true); setQuickLinkError(null)
    try {
      await api(`/api/sms/${quickLinkRow.id}/link`, { method: 'POST', body: JSON.stringify({ tx_id: txId }) })
      setQuickLinkRow(null)
      void load(true)
    } catch (e) {
      setQuickLinkError(e instanceof ApiError && e.code === 'amount_mismatch'
        ? t('المبلغ غير مطابق — افتح التفاصيل الكاملة للتأكيد.', 'Amount mismatch — open full details to confirm.')
        : e instanceof ApiError && e.code === 'assignment_window_expired'
          ? t('مرّت أكثر من 3 ساعات. افتح تفاصيل SMS ثم فك الحظر قبل الربط اليدوي.', 'More than 3 hours have passed. Open SMS details, unblock it, then link manually.')
        : e instanceof ApiError
          ? t(`فشل الربط: ${apiErrorDetail(e)}`, `Link failed: ${apiErrorDetail(e)}`)
          : t('فشل الربط: خطأ غير متوقع.', 'Link failed: unexpected error.'))
    } finally { setQuickLinkBusy(false) }
  }

  // Keep the operator-facing error actionable. The API may return a specific
  // reason (for example a blocked SMS, duplicate link, or database detail)
  // even when the error code is not yet mapped to a dedicated translation.
  const apiErrorDetail = (error: ApiError) => {
    const body = error.body ?? {}
    const detail = [body.detail, body.reason, body.message].find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    return detail ? `${detail} (${error.code})` : error.code
  }

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setLinkErr(null)
    setCandidates(null)
    setCandQ('')
    try {
      const res = await api<{ sms: SmsDetail }>(`/api/sms/${id}`)
      setSelected(res.sms)
      setMetaName(res.sms.sender_name ?? '')
      setMetaNotes(res.sms.notes ?? '')
      setMetaCategory(res.sms.manual_entry_note ?? '')
      setMetaWallet(res.sms.matched_receiving_wallet ?? res.sms.confirmed_wallet_number ?? res.sms.wallet_number ?? '')
      setAssignmentName(res.sms.sender_name ?? '')
      setExpenseComment('')
      if (res.sms.sms_category !== 'withdrawal' && !res.sms.matched_tx_id && can('sms_live', 'can_edit')) void loadCandidates(id)
    } catch {
      setErr(t('تعذّر تحميل تفاصيل الرسالة.', 'Failed to load message details.'))
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    if (Number.isInteger(requestedSmsId) && requestedSmsId > 0 && selected?.id !== requestedSmsId && !detailLoading) {
      void openDetail(requestedSmsId)
    }
  }, [requestedSmsId])

  // Deep link from the floating SMS widget's "Add" button (?manual=1).
  const manualRequested = params.get('manual') === '1'
  useEffect(() => {
    if (!manualRequested) return
    setManualOpen(true)
    const next = new URLSearchParams(params)
    next.delete('manual')
    setParams(next, { replace: true })
  }, [manualRequested])

  const closeDetail = () => {
    setSelected(null)
    const next = new URLSearchParams(params)
    next.delete('sms_id')
    setParams(next, { replace: true })
  }

  const link = async (txId: number, confirmAmountMismatch = false, changeDeclinedToPaid = false) => {
    if (!selected) return
    setLinkBusy(true)
    setLinkErr(null)
    try {
      const result = await api<{ warning?: string; amount_mismatch?: boolean; sms_amount?: number; tx_amount?: number }>(`/api/sms/${selected.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ tx_id: txId, confirm_amount_mismatch: confirmAmountMismatch }),
      })
      if (result.warning) {
        setSelected((current) => current ? {
          ...current,
          matched: true,
          match_status: 'manual',
          matched_transaction_id: txId,
          maven_transaction_id: String(txId),
          consumed_by_tx_id: txId,
          matched_tx_id: txId,
        } : current)
        setCandidates(null)
        window.dispatchEvent(new CustomEvent('ontarget:sms-assignment-success', { detail: { direction: 'in', amount: selected.amount, wallet: displayWalletForRow(selected), transactionRef: String(txId) } }))
        setLinkErr(t(
          `تم ربط الرسالة كدليل فقط لأن مبلغ SMS (${result.sms_amount ?? '—'} جنيه) لا يطابق مبلغ المعاملة (${result.tx_amount ?? '—'} جنيه). لم يتم اعتماد المعاملة تلقائياً؛ صحّح المبلغ واعتمدها يدوياً.`,
          result.warning,
        ))
        void load(true)
        return
      }
      if (changeDeclinedToPaid) {
        // Keep the linked evidence visible while the audited status change is
        // applied. The server decides whether this is a direct provider edit
        // or an approval request based on the operator's role.
        setSelected((current) => current ? {
          ...current,
          matched: true,
          match_status: 'manual',
          matched_transaction_id: txId,
          maven_transaction_id: String(txId),
          consumed_by_tx_id: txId,
          matched_tx_id: txId,
        } : current)
        try {
          await api(`/api/tx/${txId}/edit`, {
            method: 'POST',
            body: JSON.stringify({ status: 'PAID', reason: `SMS linked from SMS Live; declined transaction recovery for SMS #${selected.id}` }),
          })
        } catch (e) {
          const detail = e instanceof ApiError ? apiErrorDetail(e) : 'status_change_failed'
          setLinkErr(t(`تم ربط SMS، لكن تغيير الحالة إلى PAID فشل: ${detail}`, `SMS linked, but changing status to PAID failed: ${detail}`))
          void load(true)
          return
        }
      }
      window.dispatchEvent(new CustomEvent('ontarget:sms-assignment-success', { detail: { direction: selected.sms_category === 'withdrawal' ? 'out' : 'in', amount: selected.amount, wallet: displayWalletForRow(selected), transactionRef: String(txId) } }))
      setSelected(null)
      void load(true)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'amount_mismatch') {
        const smsAmount = Number(e.body?.sms_amount)
        const txAmount = Number(e.body?.tx_amount)
        const confirmed = window.confirm(t(
          `مبلغ SMS هو ${money(smsAmount, 'EGP')} بينما مبلغ المعاملة هو ${money(txAmount, 'EGP')}. المتابعة ستربط الرسالة كدليل فقط ولن تعتمد المعاملة تلقائياً. يجب تصحيح مبلغ المعاملة واعتمادها يدوياً. هل تريد المتابعة؟`,
          `The SMS amount is ${money(smsAmount, 'EGP')} while the transaction amount is ${money(txAmount, 'EGP')}. Continuing will link the SMS as evidence only and will not auto-approve the transaction. Correct the transaction amount and approve it manually. Continue?`,
        ))
        if (confirmed) await link(txId, true, changeDeclinedToPaid)
      } else if (e instanceof ApiError && e.code === 'already_linked') {
        setLinkErr(t('الرسالة مرتبطة بالفعل — أعد الفتح.', 'Message already linked — reopen.'))
      } else if (e instanceof ApiError && e.code === 'transaction_already_linked') {
        setLinkErr(t('هذه المعاملة مرتبطة برسالة أخرى بالفعل.', 'This transaction is already linked to another SMS.'))
      } else if (e instanceof ApiError && e.code === 'sms_transaction_date_mismatch') {
        setLinkErr(t('لا يمكن ربط SMS بمعاملة من يوم مختلف. اختر معاملة من نفس تاريخ الرسالة.', 'An SMS cannot be linked to a transaction from another day. Choose a transaction from the same SMS date.'))
      } else if (e instanceof ApiError && e.code === 'assignment_window_expired') {
        setLinkErr(t('مرّت أكثر من 3 ساعات على SMS. تم حظر التعيين؛ فك الحظر أولاً ثم نفّذ الربط اليدوي.', 'More than 3 hours have passed since this SMS. Assignment is blocked; unblock it first, then link manually.'))
        await openDetail(selected.id)
      } else if (e instanceof ApiError && e.status === 403) {
        setLinkErr(t('لا تملك صلاحية الربط (can_edit غير ممنوحة لدورك).', 'You lack link permission (can_edit not granted to your role).'))
      } else {
        const detail = e instanceof ApiError ? apiErrorDetail(e) : null
        setLinkErr(detail
          ? t(`فشل الربط: ${detail}`, `Link failed: ${detail}`)
          : t('فشل الربط: خطأ غير متوقع.', 'Link failed: unexpected error.'))
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

  const blockSms = async () => {
    if (!selected || selected.is_blocked || selected.matched_tx_id != null || selected.consumed_by_tx_id != null) return
    const reason = window.prompt(t('سبب حظر الرسالة (اختياري)', 'Reason for blocking this SMS (optional)'), t('رسالة غير مرتبطة/غير صالحة', 'Unlinked or invalid SMS'))
    if (reason === null) return
    setLinkBusy(true); setLinkErr(null)
    try {
      await api(`/api/sms/${selected.id}/block`, { method: 'POST', body: JSON.stringify({ reason }) })
      await openDetail(selected.id)
      void load(true)
    } catch (e) {
      setLinkErr(e instanceof ApiError && e.code === 'sms_must_be_unlinked'
        ? t('لا يمكن حظر رسالة مرتبطة بمعاملة.', 'A linked SMS cannot be blocked.')
        : t('فشل حظر الرسالة.', 'Failed to block SMS.'))
    } finally { setLinkBusy(false) }
  }

  const unblockSms = async () => {
    if (!selected?.is_blocked) return
    setLinkBusy(true); setLinkErr(null)
    try {
      await api(`/api/sms/${selected.id}/unblock`, { method: 'POST' })
      await openDetail(selected.id)
      void load(true)
    } catch (e) {
      setLinkErr(e instanceof ApiError && e.code === 'sms_must_be_unlinked' ? t('لا يمكن فك حظر رسالة مرتبطة.', 'A linked SMS cannot be unblocked.') : t('فشل فك حظر الرسالة.', 'Failed to unblock SMS.'))
    } finally { setLinkBusy(false) }
  }

  const recordExpense = async () => {
    if (!selected || selected.sms_category !== 'withdrawal' || !expenseComment.trim()) return
    setExpenseBusy(true); setLinkErr(null)
    try {
      await api(`/api/sms/${selected.id}/expense`, { method: 'POST', body: JSON.stringify({ comment: expenseComment.trim() }) })
      setLinkErr(t('تم تسجيل SMS السحب كمصروف في الدفتر.', 'Withdrawal SMS recorded as an expense in the financial book.'))
      setExpenseComment('')
    } catch (e) {
      setLinkErr(e instanceof ApiError && e.code === 'expense_already_recorded'
        ? t('تم تسجيل هذا SMS كمصروف من قبل.', 'This SMS was already recorded as an expense.')
        : t('فشل تسجيل المصروف.', 'Failed to record expense.'))
    } finally { setExpenseBusy(false) }
  }

  const saveWithdrawalMeta = async () => {
    if (!selected || selected.sms_category !== 'withdrawal') return
    setMetaBusy(true); setLinkErr(null)
    try {
      const res = await api<{ sms: { sender_name: string | null; notes: string | null; confirmed_wallet_number: string | null } }>(`/api/sms/${selected.id}/withdrawal-meta`, {
        method: 'PATCH', body: JSON.stringify({ sender_name: metaName, notes: metaNotes, wallet_number: metaWallet }),
      })
      setSelected({ ...selected, ...res.sms, linked_wallet_number: res.sms.confirmed_wallet_number ?? selected.wallet_number })
      window.dispatchEvent(new CustomEvent('ontarget:sms-assignment-success', { detail: { direction: 'out', amount: selected.amount, wallet: res.sms.confirmed_wallet_number ?? metaWallet, merchant: metaName.trim() || null } }))
      void load(true)
    } catch (e) {
      setLinkErr(e instanceof ApiError && e.code === 'invalid_wallet_number'
        ? t('أدخل رقم محفظة صحيحاً من 8 إلى 20 رقماً.', 'Enter a valid wallet number containing 8 to 20 digits.')
        : t('فشل حفظ بيانات السحب.', 'Failed to save withdrawal details.'))
    }
    finally { setMetaBusy(false) }
  }

  const saveUnlinkedAnnotation = async () => {
    if (!selected || selected.matched_tx_id != null || selected.consumed_by_tx_id != null) return
    setMetaBusy(true); setLinkErr(null)
    try {
      const res = await api<{ sms: { manual_entry_note: string | null; notes: string | null } }>(`/api/sms/${selected.id}/annotation`, { method: 'PATCH', body: JSON.stringify({ category: metaCategory, notes: metaNotes }) })
      setSelected({ ...selected, ...res.sms })
      void load(true)
      setLinkErr(t('تم حفظ تصنيف وملاحظة SMS غير المرتبطة.', 'Unlinked SMS category and note saved.'))
    } catch (e) {
      setLinkErr(e instanceof ApiError && e.code === 'sms_must_be_unlinked' ? t('لا يمكن تعديل SMS مرتبطة.', 'A linked SMS cannot be edited.') : t('فشل حفظ التصنيف والملاحظة.', 'Failed to save category and note.'))
    } finally { setMetaBusy(false) }
  }

  const assignWithdrawal = async () => {
    if (!selected || selected.sms_category !== 'withdrawal' || !assignmentName.trim()) return
    setAssignmentBusy(true); setLinkErr(null)
    try {
      if (/^\d{8,20}$/.test(metaWallet) && metaWallet !== (selected.confirmed_wallet_number ?? selected.wallet_number ?? '')) {
        await api(`/api/sms/${selected.id}/withdrawal-meta`, { method: 'PATCH', body: JSON.stringify({ sender_name: metaName, notes: metaNotes, wallet_number: metaWallet }) })
      }
      await api(`/api/sms/${selected.id}/withdrawal-assignment`, {
        method: 'POST',
        body: JSON.stringify({ assignment_type: assignmentType, target_reference: assignmentRef.trim(), name: assignmentName.trim(), note: metaNotes.trim() }),
      })
      window.dispatchEvent(new CustomEvent('ontarget:sms-assignment-success', { detail: { direction: 'out', amount: selected.amount, wallet: displayWalletForRow(selected), transactionRef: assignmentRef.trim(), merchant: assignmentName.trim() } }))
      await openDetail(selected.id)
      void load(true)
    } catch (e) {
      setLinkErr(e instanceof ApiError && e.code === 'payout_not_found'
        ? t('لم يتم العثور على معاملة السحب.', 'Payout transaction not found.')
        : e instanceof ApiError && e.code === 'already_linked'
          ? t('رسالة السحب مرتبطة بالفعل ولا يمكن إعادة تعيينها.', 'This withdrawal SMS is already linked and cannot be reassigned.')
        : t('فشل تعيين رسالة السحب.', 'Failed to assign withdrawal SMS.'))
    } finally { setAssignmentBusy(false) }
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1

  const selectedReport = selected ? smsReport(selected) : null
  const walletAlerts = walletPaidTotals.filter((row) => row.paid_amount >= 50_000)

  return (
    <PanelShell>
      {walletAlerts.length > 0 && !walletAlertDismissed && (
        <div className="wallet-limit-popup-backdrop" role="presentation">
          <section className="wallet-limit-popup" role="alertdialog" aria-modal="true" aria-labelledby="wallet-limit-popup-title">
            <div className="wallet-limit-popup-icon">⚠</div>
          <h3 id="wallet-limit-popup-title">{t('تنبيه حد المحفظة', 'Wallet limit alert')}</h3>
            <p>{t('وصلت المحافظ التالية إلى 50,000 جنيه مدفوع. يرجى إيقاف التوجيه أو مراجعة السعة.', 'These wallets reached 50,000 EGP paid. Please stop routing or review capacity.')}</p>
            <div className="wallet-limit-popup-list">{walletAlerts.map((row) => <div key={row.wallet}><span><span className="mono">{row.wallet}</span>{(row.transaction_ref || row.merchant) && <small>{row.transaction_ref ? `TRX ${row.transaction_ref}` : ''}{row.transaction_ref && row.merchant ? ' · ' : ''}{row.merchant ?? ''}</small>}</span><strong>{money(row.paid_amount, 'EGP')}</strong></div>)}</div>
            <button type="button" className="btn-primary" onClick={() => setWalletAlertDismissed(true)}>{t('فهمت', 'Acknowledge')}</button>
          </section>
        </div>
      )}
      <section className="page-head">
        <div className="recent-head">
          <h2 style={{ margin: 0 }}>📨 {t('SMS مباشر', 'Live SMS')}</h2>
          <Link to="/wallet-report" className="btn-ghost btn-sm">📊 {t('تقرير المحافظ ←', 'Wallet report →')}</Link>
          {can('sms_live', 'can_edit') && <span className="sms-popup-test-actions"><button type="button" className="btn-ghost btn-sm sms-test-in" onClick={() => window.dispatchEvent(new CustomEvent('ontarget:test-sms-popup', { detail: { direction: 'in', amount: 7500, wallet: '01200000000', test: true } }))}>{t('اختبار SMS داخل', 'Test SMS in')}</button><button type="button" className="btn-ghost btn-sm sms-test-out" onClick={() => window.dispatchEvent(new CustomEvent('ontarget:test-sms-popup', { detail: { direction: 'out', amount: 7500, wallet: '01200000000', test: true } }))}>{t('اختبار SMS خارج', 'Test SMS out')}</button></span>}
        </div>
        <div className="view-switch" role="group" aria-label={t('طريقة العرض', 'View mode')}>
          <button className={viewMode === 'table' ? 'active' : ''} aria-pressed={viewMode === 'table'} onClick={() => { setViewMode('table'); localStorage.setItem('sms-live-view', 'table') }}><TableProperties size={16} /> {t('جدول', 'Table')}</button>
          <button className={viewMode === 'cards' ? 'active' : ''} aria-pressed={viewMode === 'cards'} onClick={() => { setViewMode('cards'); localStorage.setItem('sms-live-view', 'cards') }}><LayoutGrid size={16} /> {t('بطاقات', 'Cards')}</button>
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
          <span className="stat-sub">{stats ? `${money(stats.deposits.dayVolume, 'EGP')} · ${from || to ? t('النطاق المحدد', 'selected range') : t('آخر 24س', 'last 24h')}` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('سحوبات', 'Withdrawals')}</span>
          <span className="stat-value">{stats ? stats.withdrawals.count.toLocaleString('en-US') : '…'}</span>
          <span className="stat-sub">{stats ? `${money(stats.withdrawals.dayVolume, 'EGP')} · ${from || to ? t('النطاق المحدد', 'selected range') : t('آخر 24س', 'last 24h')}` : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t('مرتبطة بمعاملة أو محفظة', 'Linked to transaction or wallet')}</span>
          <span className="stat-value">{stats ? stats.linked.toLocaleString('en-US') : '…'}</span>
          <span className="stat-sub">{stats && stats.total > 0 ? `${Math.round((stats.linked / stats.total) * 100)}% ${t('تغطية', 'coverage')}` : ''}</span>
        </div>
        <div className="stat-card stat-pending">
          <span className="stat-label">{t('تحتاج مراجعة', 'Needs review')}</span>
          <span className="stat-value">{stats ? stats.review.toLocaleString('en-US') : '…'}</span>
        </div>
      </div>

      {can('sms_live', 'can_edit') && <section className="card manual-sms-card">
        <div className="recent-head"><div><h3>✍️ {t('إضافة SMS يدوياً', 'Add SMS manually')}</h3><p className="page-sub">{t('استخدمها فقط عند فشل الاستقبال من الجهاز. سيتم وسمها panel_manual وتبقى غير مرتبطة حتى تراجعها.', 'Use only when device forwarding failed. It is marked panel_manual and stays unlinked until reviewed.')}</p></div><button type="button" className="btn-ghost btn-sm" onClick={() => setManualOpen((v) => !v)}>{manualOpen ? t('إغلاق', 'Close') : t('فتح النموذج', 'Open form')}</button></div>
        {manualOpen && <form className="manual-sms-form" onSubmit={submitManual}>
          <textarea className="login-input manual-sms-message" required rows={4} placeholder={t('ألصق نص SMS الخام هنا…', 'Paste the raw SMS text here…')} value={manualForm.message} onChange={e => setManualForm({ ...manualForm, message: e.target.value })} />
          <select className="login-input" value={manualForm.sms_category} onChange={e => setManualForm({ ...manualForm, sms_category: e.target.value })}><option value="deposit">{t('إيداع', 'Deposit')}</option><option value="withdrawal">{t('سحب', 'Withdrawal')}</option><option value="balance">{t('رصيد', 'Balance')}</option><option value="unknown">{t('غير معروف', 'Unknown')}</option></select>
          <input className="login-input" inputMode="decimal" placeholder={t('المبلغ', 'Amount')} value={manualForm.amount} onChange={e => setManualForm({ ...manualForm, amount: e.target.value.replace(/[^0-9.]/g, '') })} />
          <input className="login-input" placeholder={t('اسم المرسل', 'Sender name')} value={manualForm.sender_name} onChange={e => setManualForm({ ...manualForm, sender_name: e.target.value })} />
          <input className="login-input" inputMode="tel" placeholder={t('رقم المرسل', 'Sender number')} value={manualForm.sender_number} onChange={e => setManualForm({ ...manualForm, sender_number: e.target.value })} />
          <input className="login-input" inputMode="tel" placeholder={t('رقم المحفظة المستقبلة', 'Receiving wallet')} value={manualForm.receiver_number} onChange={e => setManualForm({ ...manualForm, receiver_number: e.target.value })} />
          <input className="login-input" placeholder={t('رقم العملية في SMS (اختياري)', 'SMS transaction id (optional)')} value={manualForm.trx_id} onChange={e => setManualForm({ ...manualForm, trx_id: e.target.value })} />
          <input className="login-input" type="datetime-local" value={manualForm.received_at} onChange={e => setManualForm({ ...manualForm, received_at: e.target.value })} aria-label={t('وقت الاستلام', 'Received at')} />
          <input className="login-input manual-sms-note" placeholder={t('ملاحظة المصدر', 'Source note')} value={manualForm.note} onChange={e => setManualForm({ ...manualForm, note: e.target.value })} />
          <button className="btn-primary" disabled={manualBusy || !manualForm.message.trim()}>{manualBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ SMS للمراجعة', 'Save SMS for review')}</button>
        </form>}
      </section>}

      <div className="filter-bar">
        <div className="chip-row">
          <MultiSelectFilter label={t('التصنيف','Category')} allLabel={t('كل التصنيفات','All categories')} options={['deposit','withdrawal','smslive','unknown'].map((value)=>({value,label:t(CATEGORY_META[value].ar,CATEGORY_META[value].en)}))} value={categoryValues} onChange={(values)=>setFilter({category:values.join(',')})}/>
          <MultiSelectFilter label={t('المزوّد','Provider')} allLabel={t('كل المزوّدين','All providers')} options={PROVIDER_FILTERS.map((p)=>({value:p.key,label:t(p.ar,p.en)}))} value={providerValues} onChange={(values)=>setFilter({provider:values.join(',')})}/>
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
          onSubmit={(e) => { e.preventDefault(); setFilter({ q: q.trim(), amount: amountQ.trim() }) }}
        >
          <input
            className="login-input search-input"
            placeholder={t('بحث: مُرسِل / محفظة / رقم عملية / جهاز…', 'Search: sender / wallet / tx id / device…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <input className="login-input" type="date" value={from} onChange={(e) => setFilter({ from: e.target.value })} aria-label={t('من', 'From')} />
          <input className="login-input" type="date" value={to} onChange={(e) => setFilter({ to: e.target.value })} aria-label={t('إلى', 'To')} />
          <input
            className="login-input"
            inputMode="decimal"
            placeholder={t('المبلغ الدقيق', 'Exact amount')}
            value={amountQ}
            onChange={(e) => setAmountQ(e.target.value.replace(/[^0-9.]/g, ''))}
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
              onClick={() => { setAmountQ(''); const p = new URLSearchParams(params); p.delete('amount'); setParams(p) }}
            >
              {t('مبلغ', 'Amount')} = {amount} ✕
            </button>
          )}
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}

      {data && (() => {
        const unlinked = data.rows.filter((row) => row.matched_tx_id == null && row.consumed_by_tx_id == null && !row.is_blocked)
        if (!unlinked.length) return null
        return (
          <section className="sms-unlinked-alert" aria-live="polite">
            <div className="sms-unlinked-alert-head">
              <div><span className="sms-live-beacon" aria-hidden="true" /> <strong>{t('SMS غير المرتبطة الآن', 'Unlinked SMS now')}</strong><span className="sms-unlinked-count">{unlinked.length}</span></div>
              <span>{t('اضغط لفتح الرسالة وتعيينها', 'Click a message to open and assign it')}</span>
            </div>
            <div className="sms-unlinked-strip">
              {unlinked.map((row) => (
                <button type="button" className="sms-unlinked-item" key={row.id} onClick={() => void openDetail(row.id)}>
                  <span className="sms-unlinked-item-top"><b>SMS #{row.id}</b><time>{depositTime({ first_seen_at: row.received_at })}</time></span>
                  <strong>{money(row.amount, 'EGP')}</strong>
                  <span>{row.sender_name ?? row.sender_number ?? t('مرسل غير معروف', 'Unknown sender')}</span>
                  <small className="mono">← {displayWalletForRow(row) ?? (row.wallet_identity_ambiguous ? t('غير محدد — SIM غير معروف', 'Unresolved — SIM not identified') : '—')}</small>
                </button>
              ))}
            </div>
          </section>
        )
      })()}

      <section className="card recent-card">
        {loading && !data && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {data && data.rows.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {data && data.rows.length > 0 && viewMode === 'table' && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>{t('المبلغ', 'Amount')}</th>
                  <th>{t('المرسل', 'Sender')}</th>
                  <th>{t('المستقبل', 'Receiver')}</th>
                  <th>{t('وقت الاستلام', 'Received time')}</th>
                  <th>{t('الجهاز', 'Device')}</th>
                  <th>{t('كود SMS', 'SMS code')}</th>
                  <th>{t('المعاملة المرتبطة', 'Linked transaction')}</th>
                  <th>{t('حالة الربط', 'Link status')}</th>
                  <th>{t('وقت الربط / النص الخام', 'Link time / raw SMS')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const payoutLinked = r.sms_category === 'withdrawal' && r.matched_payout_id != null
                  const linked = payoutLinked || r.matched_tx_id != null
                  const displayWallet = displayWalletForRow(r)
                  const mt = linked ? MATCH_META.auto : r.match_status ? MATCH_META[r.match_status] : null
                  const linkedAt = r.withdrawal_assigned_at
                  return (
                    <tr key={r.id} className={`sms-row sms-row-${r.sms_category === 'withdrawal' ? 'payout' : 'deposit'}${r.review_required && !linked ? ' is-review-hold' : ''}`} onClick={() => void openDetail(r.id)}>
                      <td className="mono">
                        {money(r.amount, 'EGP')}
                        {r.balance_after != null && <div className="cell-sub mono">{t('رصيد', 'bal')} {money(r.balance_after, 'EGP')}</div>}
                      </td>
                      <td><div className="sms-sender-cell"><span className={`sms-type-mark ${r.sms_category === 'withdrawal' ? 'payout' : 'deposit'}`}>{r.sms_category === 'withdrawal' ? '↗' : '↙'}</span><span>{r.sender_name ?? '—'}<div className="cell-sub mono">{r.sender_number ?? t('رقم غير معروف', 'Number unknown')}</div></span></div></td>
                      <td className="mono">{displayWallet ?? '—'}{r.receiver_number && displayWallet && r.receiver_number !== displayWallet && <div className="cell-sub">SMS: {r.receiver_number}</div>}</td>
                      <td className="mono">{depositTime({ first_seen_at: r.received_at })}<div className="cell-sub">{r.sms_category ? (CATEGORY_META[r.sms_category] ? t(CATEGORY_META[r.sms_category].ar, CATEGORY_META[r.sms_category].en) : r.sms_category) : '—'}</div></td>
                      <td className="mono">
                        <MethodLogo method={r.provider ?? 'Orange Money'} /> {r.device_name ?? '—'}
                        {r.sim_slot != null && <div className="cell-sub mono">SIM {r.sim_slot}</div>}
                      </td>
                      <td className="mono">{r.trx_id ?? '—'}<div className="cell-sub">SMS #{r.id}</div></td>
                      <td>
                        {linked ? <><span className="pay-status-badge st-paid">{r.matched_ontarget_ref ?? r.matched_tx_id ?? (payoutLinked ? `WD ${r.matched_payout_ref ?? r.matched_payout_id}` : 'Linked')}</span>{r.matched_currency && <div className="cell-sub mono">{r.matched_currency}{r.matched_sub_merchant ? ` · ${r.matched_sub_merchant}` : ''}</div>}</> : <span className="pay-status-badge st-unlinked">{t('غير مرتبطة','Unlinked')}</span>}
                      </td>
                      <td>
                        {mt ? <span className={`pay-status-badge ${mt.cls}`}>{t(mt.ar, mt.en)}</span> : <span className="pay-status-badge st-unlinked">{t('غير مرتبطة','Unlinked')}</span>}
                        {r.review_required && !linked && <div className="cell-sub sms-review-hold-label">⚠ {t('موقوف للمراجعة — تحقق خلال 3 دقائق', 'HOLD — verify within 3 minutes')}</div>}
                        {r.is_blocked && <div className="cell-sub danger-text">🚫 {t('محظورة', 'Blocked')}</div>}
                      </td>
                      <td className="sms-cell"><div className="mono">{linkedAt ? depositTime({ first_seen_at: linkedAt }) : '—'}</div><div className="cell-sub sms-raw-preview" dir="auto">{firstLine(r)}</div></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.rows.length > 0 && viewMode === 'cards' && (
          <div className="sms-card-grid">
            {data.rows.map((r) => {
              const cat = r.sms_category ? CATEGORY_META[r.sms_category] : null
              const linked = r.matched_payout_id != null || r.matched_tx_id != null
              const displayWallet = displayWalletForRow(r)
              const matchMeta = linked ? MATCH_META.auto : r.match_status ? MATCH_META[r.match_status] : null
              return <article className="sms-live-card-shell" key={r.id}>
                <button type="button" className={`sms-live-card sms-live-card-${r.sms_category === 'withdrawal' ? 'payout' : 'deposit'}${!linked && !r.is_blocked ? ' is-unlinked' : ''}${r.review_required && !linked ? ' is-review-hold' : ''}`} onClick={() => void openDetail(r.id)}>
                  <div className="sms-live-card-head"><span className="sms-card-brand"><span className={`sms-type-mark ${r.sms_category === 'withdrawal' ? 'payout' : 'deposit'}`}>{r.sms_category === 'withdrawal' ? '↗' : '↙'}</span><MethodLogo method={r.provider ?? 'Orange Money'} /></span><strong className="mono">SMS #{r.id}</strong><span className="mono">{depositTime({ first_seen_at: r.received_at })}</span></div>
                  <div className="sms-live-card-amount">{money(r.amount, 'EGP')}</div>
                  <div className="sms-live-card-grid">
                    <span>{t('النوع', 'Type')}<b>{cat ? t(cat.ar, cat.en) : '—'}</b></span>
                    <span>{t('المرسل', 'Sender')}<b>{r.sender_name ?? r.sender_number ?? '—'}</b></span>
                    <span>{t('المحفظة', 'Wallet')}<b className="mono">{displayWallet ?? '—'}</b></span>
                    <span>{t('الجهاز', 'Device')}<b className="mono">{r.device_name ?? '—'}</b></span>
                  </div>
                  <div className="sms-live-card-foot">{matchMeta ? <span className={`pay-status-badge ${matchMeta.cls}`}>{t(matchMeta.ar, matchMeta.en)}</span> : <span className="pay-status-badge st-dim">{t('غير مرتبطة', 'Unlinked')}</span>}{r.review_required && !linked && <span className="sms-review-hold-label">⚠ HOLD · {t('مراجعة 3 دقائق', '3-minute review')}</span>}{r.sms_category === 'withdrawal' && <span className="cell-sub">{r.matched_payout_id ? `WD ${r.matched_payout_ref ?? r.matched_payout_id}` : t('سحب غير معيّن', 'Unassigned withdrawal')}</span>}</div>
                  <div className="cell-sub sms-card-preview">{firstLine(r)}</div>
                </button>
                {!linked && !r.is_blocked && (
                  <div className="sms-card-actions-row">
                    <button type="button" className={`sms-card-assign-action ${r.sms_category === 'withdrawal' ? 'is-payout' : ''}`} onClick={(event) => { event.stopPropagation(); void openDetail(r.id) }}>
                      {r.sms_category === 'withdrawal' ? t('تعيين السحب', 'Assign withdrawal') : t('تعيين لمعاملة', 'Assign to transaction')} <span aria-hidden="true">→</span>
                    </button>
                    {r.sms_category !== 'withdrawal' && (
                      <button type="button" className="sms-card-quick-link" onClick={(event) => { event.stopPropagation(); openQuickLink(r) }}>
                        🔗 {t('ربط', 'Link')}
                      </button>
                    )}
                  </div>
                )}
              </article>
            })}
          </div>
        )}
        {quickLinkRow && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !quickLinkBusy) setQuickLinkRow(null) }}>
            <section className="card" style={{ maxWidth: 480 }} role="dialog" aria-modal="true" aria-labelledby="quick-link-title">
              <div className="recent-head">
                <h3 id="quick-link-title">🔗 {t('ربط SMS #', 'Link SMS #')}{quickLinkRow.id} {t('بمعاملة', 'to a transaction')}</h3>
                <button type="button" className="icon-action" disabled={quickLinkBusy} onClick={() => setQuickLinkRow(null)} aria-label={t('إغلاق', 'Close')}><X size={17} /></button>
              </div>
              <p className="cell-sub">{money(quickLinkRow.amount, 'EGP')} · {quickLinkRow.sender_name ?? quickLinkRow.sender_number ?? t('مرسل غير معروف', 'Unknown sender')}</p>
              <form className="search-row" onSubmit={(e) => { e.preventDefault(); void loadQuickLinkCandidates(quickLinkRow.id, quickLinkQuery.trim() || undefined) }}>
                <input
                  className="login-input search-input"
                  placeholder={t('بحث بالمرجع أو tx_id… (فارغ = نفس المبلغ)', 'Search by ref or tx_id… (empty = same amount)')}
                  value={quickLinkQuery}
                  onChange={(e) => setQuickLinkQuery(e.target.value)}
                />
                <button type="submit" className="btn-ghost btn-sm" disabled={quickLinkLoading}>{t('بحث', 'Search')}</button>
              </form>
              {quickLinkError && <div className="card warn">{quickLinkError}</div>}
              {quickLinkLoading && <p className="sidebar-hint">{t('جارٍ البحث…', 'Searching…')}</p>}
              {quickLinkCandidates && quickLinkCandidates.length === 0 && !quickLinkLoading && (
                <p className="sidebar-hint">{t('لا توجد معاملات مرشّحة — جرّب البحث بالمرجع.', 'No candidate transactions — try searching by ref.')}</p>
              )}
              {quickLinkCandidates && quickLinkCandidates.length > 0 && (
                <ul className="cand-list">
                  {quickLinkCandidates.map((cand) => (
                    <li key={cand.tx_id} className={`cand-item${cand.is_duplicate_group ? ' is-duplicate' : ''}`}>
                      <div className="cand-info">
                        <span className="mono">{cand.ontarget_ref ?? cand.tx_id}</span>
                        <span className={`pay-status-badge ${statusMeta(cand.status).cls}`}>{statusMeta(cand.status).label}</span>
                        {cand.is_duplicate_group && <span className="pay-status-badge is-duplicate-badge" title={t('نفس العميل والمبلغ خلال 5 دقائق — تحقق قبل الربط', 'Same client and amount within 5 minutes — verify before linking')}>{t('محتمل تكرار', 'Possible duplicate')}</span>}
                        <div className="cell-sub">
                          <span className="mono">{money(cand.amount, cand.currency)}</span>
                          {' · '}{cand.sender_name ?? cand.sender_number ?? '—'}
                          {' · '}{cand.merchant ?? '—'}
                        </div>
                      </div>
                      <button className="btn-primary btn-sm" disabled={quickLinkBusy} onClick={() => void submitQuickLink(cand.tx_id)}>
                        {t('ربط', 'Link')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        {data && totalPages > 1 && (
          <div className="pager">
            <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })}>
              → {t('السابق', 'Prev')}
            </button>
            <PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setFilter({ page: 1 }) }} />
            <span className="pager-info mono">{page} / {totalPages}</span>
            <button className="btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setFilter({ page: page + 1 })}>
              {t('التالي', 'Next')} ←
            </button>
          </div>
        )}
      </section>

      {(selected || detailLoading) && (
        <div className="drawer-backdrop" onClick={closeDetail}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {detailLoading && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
            {selected && (
              <>
                <div className="drawer-head">
                  <h3 className="mono">SMS #{selected.id}</h3>
                  <button className="btn-ghost btn-sm" onClick={closeDetail}>✕</button>
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
                  <div className="sms-phone-preview-wrap">
                    <span className="field-label">{t('معاينة الرسالة على الهاتف', 'Phone message preview')}</span>
                    <div className="sms-phone-frame" role="img" aria-label={t('معاينة SMS داخل شاشة هاتف', 'SMS preview inside phone screen')}>
                      <div className="sms-phone-notch" />
                      <div className="sms-phone-status"><span>9:41</span><span>●●● ᯤ 🔋</span></div>
                      <div className="sms-phone-header"><span>‹</span><strong>{selected.sms_sender ?? selected.provider ?? t('الرسائل', 'Messages')}</strong><span>ⓘ</span></div>
                      <div className="sms-phone-content"><small>{selected.sender_name ?? selected.sender_number ?? t('مرسل غير معروف', 'Unknown sender')}</small><time>{selected.received_at ? new Date(selected.received_at).toLocaleString() : '—'}</time><pre className="sms-phone-bubble">{selected.message}</pre></div>
                    </div>
                    <span className="cell-sub">{selected.sms_category === 'withdrawal' && selected.linked_wallet_number ? t('SMS الخام المرتبطة بالمحفظة', 'Raw SMS linked to wallet') : t('SMS الخام', 'Raw SMS')}</span>
                  </div>
                )}

                {selectedReport && (
                  <section className="sms-provider-report" aria-label={t('تقرير الرسالة', 'SMS report')}>
                    <div className="sms-provider-report-divider"><span>{t('غير مقروءة', 'Unread')}</span></div>
                    <time className="sms-provider-report-time">{selectedReport.time}</time>
                    <div className="sms-provider-report-bubble" dir="auto">
                      <strong>{selectedReport.provider}</strong>
                      <div className="sms-provider-report-amount">{money(selectedReport.amount, 'EGP')}</div>
                      <dl>
                        <dt>{t('المرسل', 'From')}</dt><dd className="mono">{selectedReport.phone ?? '—'}</dd>
                        <dt>{t('الرصيد الحالي', 'Current balance')}</dt><dd className="mono">{money(selectedReport.balance, 'EGP')}</dd>
                        <dt>{t('تاريخ العملية', 'Transaction date')}</dt><dd className="mono">{selectedReport.date}</dd>
                        <dt>{t('رقم العملية', 'Transaction number')}</dt><dd className="mono">{selectedReport.ref ?? '—'}</dd>
                      </dl>
                    </div>
                    <span className="cell-sub">{t('تقرير مستخرج من SMS الخام', 'Report extracted from raw SMS')}</span>
                  </section>
                )}

                <section className="sms-detail-evidence">
                  <div className="sms-detail-evidence-head"><strong>{t('بيانات الرسالة الخام', 'SMS evidence')}</strong><span className="cell-sub">{selected.raw_sms ? 'raw_sms' : 'message'}</span></div>
                  <pre className="sms-raw-block" dir="auto">{selected.raw_sms ?? selected.message ?? selected.sms_first_line ?? '—'}</pre>
                  {selected.balance_after != null && <div className="sms-balance-line sms-drawer-balance"><span className="sms-balance-dot" aria-hidden="true" /><span>{t('الرصيد الحالي بعد الرسالة', 'Current balance after SMS')}</span><strong className="mono">{money(selected.balance_after, 'EGP')}</strong></div>}
                  <details className="sms-json-details"><summary>{t('عرض JSON المستخرج', 'Show extracted JSON')}</summary><pre>{JSON.stringify(selected.raw_payload ?? {}, null, 2)}</pre></details>
                </section>

                <dl className="detail-grid">
                  <dt>{t('المُرسِل', 'Sender')}</dt><dd>{selected.sender_name ?? '—'} {selected.sender_number && <span className="mono">({selected.sender_number})</span>}</dd>
                  <dt>{selected.sms_category === 'withdrawal' ? t('المحفظة الدافعة', 'Paying wallet') : t('المحفظة المستقبِلة', 'Receiving wallet')}</dt><dd className="mono">{selected.sms_category === 'withdrawal' ? selected.linked_wallet_number ?? (selected.wallet_identity_ambiguous ? null : selected.wallet_number) ?? '—' : displayWalletForRow(selected) ?? selected.wallet ?? (selected.wallet_identity_ambiguous ? t('غير محدد — SIM غير معروف', 'Unresolved — SIM not identified') : '—')}{selected.wallet_identity_ambiguous && <div className="cell-sub danger-text">⚠ {t('تم إخفاء الرقم لأن الرسالة لم تحدد SIM الصحيحة', 'Hidden because the SMS did not identify the SIM')}</div>}{selected.sms_category !== 'withdrawal' && selected.receiver_number && displayWalletForRow(selected) && displayWalletForRow(selected) !== selected.receiver_number && <div className="cell-sub">SMS receiver {selected.receiver_number}</div>}</dd>
                  <dt>{t('المزوّد', 'Provider')}</dt><dd>{selected.provider ?? '—'} · <span className="mono">{selected.sms_sender ?? '—'}</span></dd>
                  <dt>{t('التاجر', 'Merchant')}</dt><dd>{selected.matched_master_merchant ?? displayValue(payloadValue(selected, ['merchant', 'merchant_name', 'MerchantName']))}</dd>
                  <dt>{t('الطريقة', 'Method')}</dt><dd>{selected.method ?? displayValue(payloadValue(selected, ['method', 'payment_method', 'iPayinfo']))}</dd>
                  <dt>{t('الجهاز', 'Device')}</dt><dd className="mono">{selected.device_name ?? '—'}{selected.sim_slot != null && <> · SIM {selected.sim_slot}</>}</dd>
                  <dt>{t('رقم العملية (SMS)', 'Tx id (SMS)')}</dt><dd className="mono">{selected.trx_id ?? '—'}</dd>
                  {selected.sms_category !== 'withdrawal' && <><dt>{t('معاملة OnTarget', 'OnTarget tx')}</dt><dd className="mono">{selected.matched_ontarget_ref ?? selected.matched_tx_id ?? '—'}</dd></>}
                  {selected.sms_category !== 'withdrawal' && selected.matched_tx_id != null && <>
                    <dt>{t('محفظة المعاملة', 'Transaction wallet')}</dt><dd className="mono">{selected.matched_receiving_wallet ?? '—'} {selected.wallet_match === false ? '⚠ mismatch' : selected.wallet_match ? '✓ matched' : ''}</dd>
                    <dt>{t('عملة المعاملة', 'Transaction currency')}</dt><dd className="mono">{selected.matched_currency ?? '—'}</dd>
                    <dt>{t('التاجر الفرعي', 'Sub-merchant')}</dt><dd>{selected.matched_master_merchant?.toLowerCase() === 'payfuture' ? `PayFuture · ${selected.matched_sub_merchant ?? 'not set'}` : selected.matched_sub_merchant ?? '—'}</dd>
                  </>}
                  {selected.sms_category === 'withdrawal' && <><dt>{t('معيّنة لسحب','Assigned to WD')}</dt><dd>{selected.matched_payout_id ? <Link className="transaction-cell-link mono" to={`/payouts?q=${encodeURIComponent(selected.matched_payout_ref ?? String(selected.matched_payout_id))}`}>WD {selected.matched_payout_ref ?? selected.matched_payout_id}{selected.matched_payout_status ? ` · ${selected.matched_payout_status}` : ''}</Link> : <span className="pay-status-badge st-declined">{t('غير معيّنة','Unassigned')}</span>}</dd></>}
                  {selected.withdrawal_assignment_type && <><dt>{t('التعيين اليدوي','Manual assignment')}</dt><dd>{selected.withdrawal_assignment_type === 'payout' ? 'Payout' : selected.withdrawal_assignment_type === 'p2p_usdt' ? 'P2P USDT' : selected.withdrawal_assignment_type === 'mina_cash' ? 'Mina cash' : 'Cash must return'} · {selected.withdrawal_assignment_name}{selected.withdrawal_assignment_reference ? ` · ${selected.withdrawal_assignment_reference}` : ''}<div className="cell-sub">{selected.withdrawal_assigned_by ?? '—'}</div></dd></>}
                  <dt>{t('حالة الربط', 'Link status')}</dt><dd className="mono">{selected.sms_category === 'withdrawal' ? selected.matched_payout_id ? t('مرتبطة بمعاملة سحب','Linked to payout') : selected.linked_wallet_number ? t('مرتبطة بالمحفظة فقط','Wallet only') : t('غير مرتبطة','Unlinked') : selected.match_status ?? '—'}{selected.review_required && !selected.matched && selected.sms_category !== 'withdrawal' && <> · ⚠ {t('تحتاج مراجعة', 'needs review')}</>}</dd>
                  {selected.is_blocked && <><dt>{t('حظر SMS', 'SMS block')}</dt><dd className="danger-text">🚫 {selected.block_reason ?? t('محظورة يدوياً', 'Blocked manually')} · {selected.blocked_by ?? '—'}</dd></>}
                  <dt>{t('الرصيد بعد العملية', 'Balance after')}</dt><dd className="mono">{money(selected.balance_after, 'EGP')}</dd>
                  <dt>{t('الرسوم', 'Fees')}</dt><dd className="mono">{selected.raw_payload ? money(Number(payloadValue(selected, ['fees', 'fee', 'commission'])), 'EGP') : '—'}</dd>
                  <dt>{t('المخاطر', 'Risk')}</dt><dd>{selected.risk_score != null ? <span className={selected.risk_score > 0 ? 'danger-text' : ''}>{selected.risk_score}{selected.risk_reason && <> · {selected.risk_reason}</>}</span> : t('غير متاح','Not available')}</dd>
                  <dt>Webhook</dt><dd className="mono">{selected.webhook_name ?? '—'}{selected.webhook_address && <div className="cell-sub">{selected.webhook_address}</div>}</dd>
                  <dt>SIM</dt><dd className="mono">{selected.sim_slot ?? displayValue(payloadValue(selected, ['sim', 'sim_number', 'sim_slot']))}</dd>
                  <dt>GPS</dt><dd className="mono">{displayValue(payloadValue(selected, ['gps', 'location', 'coordinates']))}{payloadValue(selected, ['latitude']) != null && <> · {displayValue(payloadValue(selected, ['latitude']))}, {displayValue(payloadValue(selected, ['longitude']))}</>}</dd>
                  <dt>IP</dt><dd className="mono">{displayValue(payloadValue(selected, ['ip', 'ip_address', 'client_ip']))}</dd>
                  {selected.sms_category === 'withdrawal' && <><dt>{t('حساب الرصيد', 'Balance calculation')}</dt><dd className="mono">{selected.wallet_balance_before != null ? money(selected.wallet_balance_before, 'EGP') : '—'} − {money(selected.amount, 'EGP')} = {selected.wallet_balance_after != null ? money(selected.wallet_balance_after, 'EGP') : '—'}</dd></>}
                  {selected.is_duplicate && <><dt>{t('تكرار', 'Duplicate')}</dt><dd>⚠ {t('رسالة مكررة', 'Duplicate message')}</dd></>}
                  <dt>{t('المشغّل المسؤول', 'Assigned operator')}</dt><dd>{selected.assigned_operator ?? '—'}</dd>
                  {selected.notes && <><dt>{t('ملاحظات', 'Notes')}</dt><dd>{selected.notes}</dd></>}
                  <dt>{t('وقت الاستلام', 'Received at')}</dt><dd className="mono">{depositTime({ first_seen_at: selected.received_at })}</dd>
                </dl>

                <section className="sms-detail-timeline"><h4>{t('الخط الزمني', 'Timeline')}</h4><ol>{[
                  [t('استلام SMS', 'SMS received'), selected.received_at],
                  [t('إنشاء السجل', 'Record created'), selected.created_at],
                  [t('معالجة الرسالة', 'Processed'), selected.processed_at],
                  [t('مزامنة Maven', 'Maven synced'), selected.maven_synced_at],
                  [t('تعيين السحب', 'Withdrawal assigned'), selected.withdrawal_assigned_at],
                ].filter(([, at]) => at).map(([label, at]) => <li key={String(label) + String(at)}><span className="timeline-dot"/><div><strong>{label}</strong><time className="mono">{new Date(String(at)).toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })}</time></div></li>)}</ol></section>

                {selected.sms_category !== 'withdrawal' && selected.matched_tx_id == null && selected.consumed_by_tx_id == null && !selected.is_blocked && can('sms_live', 'can_edit') && (
                  <section className="link-section unlinked-annotation-editor">
                    <h4>📝 {t('تصنيف SMS غير المرتبطة', 'Unlinked SMS annotation')}</h4>
                    <label className="filter-field">{t('التصنيف', 'Category')}<input className="login-input" maxLength={120} value={metaCategory} onChange={(e) => setMetaCategory(e.target.value)} placeholder={t('مثال: أموال إضافية · #12493', 'Example: Extra fund · #12493')} /></label>
                    <label className="filter-field">{t('ملاحظة المشغّل', 'Operator note')}<textarea className="login-input" rows={3} maxLength={2000} value={metaNotes} onChange={(e) => setMetaNotes(e.target.value)} placeholder={t('مثال: 700 EGP أموال إضافية', 'Example: 700 EGP extra fund')} /></label>
                    <button className="btn-primary btn-sm" disabled={metaBusy || (!metaCategory.trim() && !metaNotes.trim())} onClick={() => void saveUnlinkedAnnotation()}>{metaBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ التصنيف والملاحظة', 'Save category and note')}</button>
                  </section>
                )}

                {selected.is_blocked && selected.matched_tx_id == null && selected.consumed_by_tx_id == null && can('sms_live', 'can_edit') && (
                  <div className="drawer-actions">
                    <button className="btn-primary btn-sm" disabled={linkBusy} onClick={() => void unblockSms()}>
                      🔓 {t('فك الحظر والسماح بالتعيين', 'Unblock and allow assignment')}
                    </button>
                  </div>
                )}

                {selected.sms_category === 'withdrawal' && can('sms_live', 'can_edit') && (
                  <section className="link-section withdrawal-meta-editor">
                    <h4>{t('بيانات السحب التشغيلية', 'Withdrawal operational details')}</h4>
                    <label className="filter-field">{t('رقم محفظتنا', 'Our wallet number')}<input className="login-input mono" inputMode="numeric" maxLength={20} value={metaWallet} onChange={(e) => setMetaWallet(e.target.value.replace(/\D/g, ''))} placeholder="01XXXXXXXXX"/></label>
                    <label className="filter-field">{t('الاسم', 'Name')}<input className="login-input" maxLength={160} value={metaName} onChange={(e) => setMetaName(e.target.value)} placeholder={t('اسم صاحب المحفظة أو المستفيد', 'Wallet owner or beneficiary name')}/></label>
                    <label className="filter-field">{t('ملاحظة', 'Note')}<textarea className="login-input" rows={3} maxLength={2000} value={metaNotes} onChange={(e) => setMetaNotes(e.target.value)} placeholder={t('ملاحظة تشغيلية تظهر في تفاصيل SMS', 'Operational note shown in SMS details')}/></label>
                    <button className="btn-primary btn-sm" disabled={metaBusy || !/^\d{8,20}$/.test(metaWallet)} onClick={() => void saveWithdrawalMeta()}>{metaBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ بيانات السحب', 'Save withdrawal details')}</button>
                    <h4>{t('تعيين رسالة السحب', 'Assign withdrawal SMS')}</h4>
                    <label className="filter-field">{t('نوع التعيين', 'Assignment type')}<select className="login-input" value={assignmentType} onChange={(e) => setAssignmentType(e.target.value as typeof assignmentType)}><option value="payout">Payout</option><option value="p2p_usdt">P2P USDT</option><option value="cash_return">Cash must return</option><option value="mina_cash">Mina cash</option></select></label>
                    <label className="filter-field">{t('المحفظة الدافعة', 'Sending wallet')}<input className="login-input mono" inputMode="numeric" maxLength={20} value={metaWallet} onChange={(e) => setMetaWallet(e.target.value.replace(/\D/g, ''))} placeholder="01XXXXXXXXX" /></label>
                    <label className="filter-field">{assignmentType === 'cash_return' ? t('اسم المستلم', 'Receiver name') : t('الاسم', 'Name')}<input className="login-input" maxLength={160} value={assignmentName} onChange={(e) => setAssignmentName(e.target.value)} placeholder={assignmentType === 'cash_return' ? t('اسم من استلم النقد المرتجع', 'Name of the person who received the cash back') : undefined} required /></label>
                    <label className="filter-field">{assignmentType === 'payout' ? t('رقم معاملة السحب', 'Payout transaction/ref') : t('المرجع', 'Reference')}<input className="login-input" maxLength={160} value={assignmentRef} onChange={(e) => setAssignmentRef(e.target.value)} placeholder={assignmentType === 'payout' ? 'WD ref or Maven ID' : t('مرجع اختياري', 'Optional reference')} /></label>
                    <button className="btn-primary btn-sm" disabled={assignmentBusy || !assignmentName.trim() || (assignmentType === 'payout' && !assignmentRef.trim())} onClick={() => void assignWithdrawal()}>{assignmentBusy ? t('جارٍ التعيين…', 'Assigning…') : t('تعيين', 'Assign')}</button>
                    <h4>{t('تسجيل SMS السحب كمصروف', 'Record withdrawal SMS as expense')}</h4>
                    <label className="filter-field">{t('تعليق المصروف', 'Expense comment')}<textarea className="login-input" rows={3} maxLength={500} value={expenseComment} onChange={(e) => setExpenseComment(e.target.value)} placeholder={t('مثال: سحب نقدي من محفظة ont3', 'Example: Cash withdrawal from ont3 wallet')} /></label>
                    <button className="btn-ghost btn-sm" disabled={expenseBusy || !expenseComment.trim()} onClick={() => void recordExpense()}>{expenseBusy ? t('جارٍ التسجيل…', 'Recording…') : t('إضافة كمصروف', 'Add as expense')}</button>
                  </section>
                )}

                {linkErr && <div className="card warn">{linkErr}</div>}

                {selected.sms_category !== 'withdrawal' && selected.matched_tx_id != null && can('sms_live', 'can_edit') && (
                  <div className="drawer-actions">
                    <button className="btn-ghost danger" disabled={linkBusy} onClick={() => void unlink()}>
                      🔗 {t('فك الربط عن المعاملة', 'Unlink from transaction')}
                    </button>
                  </div>
                )}

                {selected.sms_category !== 'withdrawal' && selected.matched_tx_id == null && !selected.is_blocked && can('sms_live', 'can_edit') && (
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
                          <li key={cand.tx_id} className={`cand-item${cand.is_duplicate_group ? ' is-duplicate' : ''}`}>
                            <div className="cand-info">
                              <span className="mono">{cand.ontarget_ref ?? cand.tx_id}</span>
                              <span className={`pay-status-badge ${statusMeta(cand.status).cls}`}>{statusMeta(cand.status).label}</span>
                              {cand.is_duplicate_group && <span className="pay-status-badge is-duplicate-badge" title={t('نفس العميل والمبلغ خلال 5 دقائق — تحقق قبل الربط', 'Same client and amount within 5 minutes — verify before linking')}>{t('محتمل تكرار', 'Possible duplicate')}</span>}
                              <div className="cell-sub">
                                <span className="mono">{money(cand.amount, cand.currency)}</span>
                                {' · '}{cand.sender_name ?? cand.sender_number ?? '—'}
                                {' · '}{cand.merchant ?? '—'}
                                {cand.master_merchant?.toLowerCase() === 'payfuture' && <><br /><span>PayFuture · {cand.sub_merchant ?? 'sub-merchant not set'}</span></>}
                                {cand.receiving_wallet ?? cand.to_account_number ? <><br /><span className="mono">Wallet {cand.receiving_wallet ?? cand.to_account_number} · {cand.currency ?? '—'}</span></> : null}
                                {' · '}<span className="mono">{depositTime({ first_seen_at: cand.first_seen_at })}{cand.seconds_diff != null && <>{' · '}<strong className={cand.seconds_diff <= 180 ? 'sms-near-time' : undefined}>{cand.seconds_diff}s {t('فرق الوقت', 'time gap')}</strong></>}</span>
                              </div>
                            </div>
                            <div className="cand-actions">
                              <button
                                className="btn-primary btn-sm"
                                disabled={linkBusy}
                                onClick={() => void link(cand.tx_id)}
                              >
                                {t('ربط', 'Link')}
                              </button>
                              {cand.status === 'DECLINED' && can('transactions', 'can_edit') && <button
                                className="btn-ghost btn-sm danger"
                                disabled={linkBusy}
                                title={t('يربط SMS ثم يطلب تغيير الحالة إلى مدفوعة', 'Link SMS, then apply audited PAID status')}
                                onClick={() => void link(cand.tx_id, false, true)}
                              >
                                ✅ {t('ربط + PAID', 'Link + PAID')}
                              </button>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {selected.sms_category !== 'withdrawal' && selected.matched_tx_id == null && selected.consumed_by_tx_id == null && !selected.is_blocked && can('sms_live', 'can_edit') && (
                  <div className="drawer-actions">
                    <button className="btn-ghost danger" disabled={linkBusy} onClick={() => void blockSms()}>
                      🚫 {t('حظر SMS غير المرتبطة', 'Block unlinked SMS')}
                    </button>
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
