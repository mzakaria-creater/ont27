import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'
import { learnTrustedSmsName } from './clientIdentity.js'
import { autoApproveMatchedPayout } from './payoutSmsMatcher.js'
import { isWalidCompanyMethod } from './autoApprovalPolicy.js'
import { flagAmbiguousCandidates } from './duplicateDetection.js'

// SMS Live = inbound_sms (device-forwarded wallet SMS). The panel surfaces the
// live queue + its Maven transaction links, mirroring the old "SMS operations
// center" tab. Read-only for now — manual linking is a later flow.

export const smsRoutes = new Hono<AuthEnv>()

smsRoutes.use('*', requireAuth)

const LIST_COLUMNS =
  'id, received_at, device_name, sim_slot, sender_number, sender_name, receiver_number, wallet_number, confirmed_wallet_number, amount, balance_after, sms_category, match_status, matched, review_required, is_blocked, block_reason, blocked_at, blocked_by, assignment_unlocked_at, assignment_unlocked_by, trx_id, matched_transaction_id, maven_transaction_id, consumed_by_tx_id, provider, sms_sender, sms_first_line, raw_sms, message, raw_payload, webhook_name, webhook_address, method, ocr_text, score, auto_match_score, processed_at, maven_synced, maven_synced_at, maven_status_sent'

// Three separate ingestion paths (the sms-inbound webhook, a direct "live"
// path, and the legacy_mirror replication job) all write into inbound_sms,
// and regularly write the SAME physical SMS twice within a few seconds of
// each other under the same trx_id — confirmed by inspecting live rows, not
// assumed. That's an ingestion-side issue outside this repo (those pipelines
// run as Supabase Edge Functions on a different project); this only hides
// the duplicate in what operators see. Keeps whichever twin is more useful:
// already matched/consumed, then has a real amount, then has a real
// sender_number, then the lowest id (stable, deterministic tie-break).
function dedupeByTrxId(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const bestByTrx = new Map<string, Record<string, unknown>>()
  const passthrough: Record<string, unknown>[] = []
  for (const row of rows) {
    const trxId = row.trx_id
    if (typeof trxId !== 'string' || !trxId.trim()) { passthrough.push(row); continue }
    const current = bestByTrx.get(trxId)
    if (!current) { bestByTrx.set(trxId, row); continue }
    const score = (r: Record<string, unknown>) =>
      (r.consumed_by_tx_id != null || r.matched === true ? 4 : 0) +
      (r.amount != null ? 2 : 0) +
      (r.sender_number != null ? 1 : 0)
    if (score(row) > score(current) || (score(row) === score(current) && Number(row.id) < Number(current.id))) {
      bestByTrx.set(trxId, row)
    }
  }
  return [...passthrough, ...bestByTrx.values()].sort((a, b) => {
    const byTime = String(b.received_at ?? '').localeCompare(String(a.received_at ?? ''))
    return byTime !== 0 ? byTime : Number(b.id) - Number(a.id)
  })
}

function sinceIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

type SmsFilterInput = {
  category?: string
  match?: string
  q?: string
  amount?: string
  from?: string
  to?: string
  provider?: string
}

// Same channel groupings MethodLogo already uses to pick each row's icon —
// the provider filter deliberately matches that, not a separate taxonomy.
// The raw `provider` column is inconsistent (orange-cash, Orange Money,
// vodafone-cash, ...), so each channel is an OR-group of ilike patterns
// rather than an exact match.
const PROVIDER_FILTER_PATTERNS: Record<string, string[]> = {
  orange_cash: ['%orange%'],
  vodafone_cash: ['%vodafone%', '%vf-cash%', '%vf cash%'],
  we_pay: ['%we pay%', '%wepay%', '%we-pay%'],
  instapay: ['%instapay%', '%insta pay%'],
  alex_bank: ['%alexbank%', '%alex bank%', '%bank of alexandria%'],
}

const CAIRO_TIME_ZONE = 'Africa/Cairo'
function cairoOffset(date: string): string {
  const guess = new Date(`${date}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CAIRO_TIME_ZONE, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute))
  const offsetMinutes = Math.round((asUtc - guess.getTime()) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'; const absolute = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
function cairoBoundary(date: string, end = false): string { return `${date}T${end ? '23:59:59.999' : '00:00:00'}${cairoOffset(date)}` }

type QueueSms = Record<string, unknown> & { id: number; amount: number | null; received_at: string | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; provider: string | null }
type QueueTx = { tx_id: number; amount: number | null; sender_name: string | null; sender_number: string | null; receiving_wallet: string | null; to_account_number: string | null; first_seen_at: string | null }
const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100)
const nameKey = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((part) => part.length > 1).join(' ')
const phoneKey = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
const sameName = (left: unknown, right: unknown) => { const a = nameKey(left); const b = nameKey(right); return Boolean(a && b && (a === b || a.includes(b) || b.includes(a))) }
const NETWORK_SOURCE_RE = /orange\s*cash|orange\s*money|اورنچ\s*كاش|اورنج\s*كاش|vodafone\s*cash|vf[- ]?cash|فودافون\s*كاش|alex\s*bank|alexbank|بنك\s*الاسكندرية|insta\s*pay|instapay|انستا\s*باي|انستاباي/i
const PHONE_SENDER_HEADER_RE = /^\s*from\s*:\s*\+?\d[\d\s-]{7,}/im
const isNetworkProviderSms = (sms: QueueSms) => {
  const text = `${sms.provider ?? ''} ${sms.message ?? ''} ${sms.raw_sms ?? ''}`
  return !PHONE_SENDER_HEADER_RE.test(text) && NETWORK_SOURCE_RE.test(text)
}
const queueTime = (value: unknown) => { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) ? parsed : null }
function cairoDayKey(value: unknown): string | null {
  const at = queueTime(value)
  if (at == null) return null
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CAIRO_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
const SMS_ASSIGNMENT_GRACE_MS = 3 * 60 * 60_000

function balanceContinuity(sms: QueueSms, history: QueueSms[]) {
  const wallet = phoneKey(sms.receiver_number)
  const at = queueTime(sms.received_at)
  const balance = Number(sms.balance_after)
  const amount = Number(sms.amount)
  if (!wallet || at == null || !Number.isFinite(balance) || !Number.isFinite(amount)) return false
  const previous = history
    .filter((row) => phoneKey(row.receiver_number) === wallet && row.id !== sms.id && Number.isFinite(Number(row.balance_after)) && (queueTime(row.received_at) ?? 0) < at)
    .sort((a, b) => (queueTime(b.received_at) ?? 0) - (queueTime(a.received_at) ?? 0))[0]
  if (!previous) return false
  return Math.abs(balance - (Number(previous.balance_after) + amount)) <= 1
}

function queueCandidates(sms: QueueSms, transactions: QueueTx[], balanceHistory: QueueSms[]) {
  if (!isNetworkProviderSms(sms)) return []
  const smsAt = queueTime(sms.received_at)
  const smsWallet = phoneKey(sms.receiver_number)
  const smsPhone = phoneKey(sms.sender_number)
  const orange = /orange/i.test(`${sms.provider ?? ''} ${sms.message ?? ''} ${sms.raw_sms ?? ''}`)
  return transactions.filter((tx) => {
    // Match against Maven's current wallet first. A historical receiving_wallet
    // match is review-only and must not be presented as an auto-link candidate.
    if (cents(tx.amount) !== cents(sms.amount) || !smsWallet || phoneKey(tx.to_account_number ?? tx.receiving_wallet) !== smsWallet) return false
    const txAt = queueTime(tx.first_seen_at)
    if (smsAt == null || txAt == null || Math.abs(smsAt - txAt) > 10 * 60_000) return false
    if (smsPhone) return !phoneKey(tx.sender_number) || phoneKey(tx.sender_number) === smsPhone
    return orange && sameName(sms.sender_name, tx.sender_name) && balanceContinuity(sms, balanceHistory)
  })
}

function isPotentialDeposit(sms: QueueSms) {
  if (!isNetworkProviderSms(sms)) return false
  const hasAmount = Number.isFinite(Number(sms.amount))
  const hasWallet = Boolean(phoneKey(sms.receiver_number))
  const hasPhone = Boolean(phoneKey(sms.sender_number))
  const orange = /orange/i.test(`${sms.provider ?? ''} ${sms.message ?? ''} ${sms.raw_sms ?? ''}`)
  const hasName = Boolean(nameKey(sms.sender_name))
  return hasAmount && hasWallet && (hasPhone || (orange && hasName))
}

// Keep the list and KPI cards on one definition of "filtered SMS". This is
// deliberately shared: adding a filter to the table without adding it to the
// cards was the reason their numbers previously looked stale/wrong.
function applySmsFilters(query: any, filters: SmsFilterInput) {
  const { category, match, q, amount, from, to, provider } = filters
  // Only approved financial inbox senders belong in Live SMS or matching.
  // Unsupported messages are retained for audit but hidden from operations.
  query = query.or('is_blocked.eq.false,is_blocked.is.null')
  const categories = (category ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  if (categories.length) query = query.in('sms_category', categories)
  const providers = (provider ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  const providerPatterns = providers.flatMap((key) => PROVIDER_FILTER_PATTERNS[key] ?? [])
  if (providerPatterns.length) query = query.or(providerPatterns.map((pattern) => `provider.ilike.${pattern}`).join(','))
  if (from) query = query.gte('received_at', cairoBoundary(from))
  if (to) query = query.lte('received_at', cairoBoundary(to, true))
  // Link state is derived from every authoritative/legacy link column. The
  // old filter only checked consumed_by_tx_id (and wallet_number for WD), so
  // repaired rows with matched_transaction_id/maven_transaction_id appeared
  // as unlinked and were offered for assignment again.
  if (match === 'linked') query = query.or('matched.eq.true,consumed_by_tx_id.not.is.null,matched_transaction_id.not.is.null,maven_transaction_id.not.is.null')
  else if (match === 'unmatched') query = query.or('matched.eq.false,matched.is.null').is('consumed_by_tx_id', null).is('matched_transaction_id', null).is('maven_transaction_id', null)
  else if (match === 'review') query = query.eq('review_required', true).eq('matched', false)

  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [
      `sender_name.ilike.${like}`,
      `sender_number.ilike.${like}`,
      `receiver_number.ilike.${like}`,
      `wallet_number.ilike.${like}`,
      `confirmed_wallet_number.ilike.${like}`,
      `trx_id.ilike.${like}`,
      `device_name.ilike.${like}`,
      `provider.ilike.${like}`,
      `sms_first_line.ilike.${like}`,
      `raw_sms.ilike.${like}`,
      `message.ilike.${like}`,
    ]
    if (/^\d+$/.test(q)) {
      ors.push(`id.eq.${q}`)
      ors.push(`matched_transaction_id.eq.${q}`)
      ors.push(`consumed_by_tx_id.eq.${q}`)
    }
    query = query.or(ors.join(','))
  }
  if (amount && /^\d+(\.\d+)?$/.test(amount)) query = query.eq('amount', amount)
  return query
}

// Resolve each matched SMS to the ontarget_ref of its transaction, so the UI
// can show the same identifier the deposits/transactions views show instead of
// a bare tx_id that an operator has to look up by hand.
//
// Four link sources. consumed_by_tx_id comes FIRST because it is the one the
// live engine actually writes when it claims an SMS — 3,981 rows against 1,315
// in sms_maven_matches — and the older sources stopped growing: match_status
// last moved to 'auto' on 2026-07-11. Resolving by the legacy columns alone
// left recent matches looking unlinked.
async function attachMatchedRef(rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return
  const withdrawalRows = rows.filter((row) => row.sms_category === 'withdrawal')
  for (const row of withdrawalRows) {
    row.linked_wallet_number = row.confirmed_wallet_number ?? row.wallet_number ?? null
    const amount = Number(row.amount)
    const after = Number(row.balance_after)
    row.wallet_balance_after = row.balance_after ?? null
    row.wallet_balance_before = row.balance_after != null && Number.isFinite(after) && Number.isFinite(amount) ? after + amount : null
    row.matched_tx_id = null
    row.matched_ontarget_ref = null
    row.matched_payout_id = null
    row.matched_payout_ref = null
    row.matched_payout_status = null
    row.matched_currency = null
    row.matched_sub_merchant = null
    row.matched_master_merchant = null
    row.matched_gateway = null
    row.matched_receiving_wallet = null
    row.wallet_match = null
  }
  const withdrawalIds = withdrawalRows.map((row) => Number(row.id)).filter(Number.isFinite)
  if (withdrawalIds.length) {
    const { data: assignments } = await db.from('sms_withdrawal_assignments')
      .select('sms_id, assignment_type, target_reference, display_name, note, assigned_by, assigned_at')
      .in('sms_id', withdrawalIds)
    const assignmentBySms = new Map((assignments ?? []).map((item) => [Number(item.sms_id), item]))
    for (const row of withdrawalRows) {
      const assignment = assignmentBySms.get(Number(row.id))
      if (!assignment) continue
      row.withdrawal_assignment_type = assignment.assignment_type
      row.withdrawal_assignment_reference = assignment.target_reference
      row.withdrawal_assignment_name = assignment.display_name
      row.withdrawal_assigned_by = assignment.assigned_by
      row.withdrawal_assigned_at = assignment.assigned_at
    }
  }
  const payoutId = (row: Record<string, unknown>): number | null => {
    const raw = row.consumed_by_tx_id ?? row.matched_transaction_id
    const id = Number(raw)
    return raw != null && Number.isFinite(id) ? id : null
  }
  const payoutIds = [...new Set(withdrawalRows.map(payoutId).filter((id): id is number => id != null))]
  if (payoutIds.length) {
    const { data: payouts } = await db.from('maven_payout_transactions').select('maven_id, ontarget_ref, status').in('maven_id', payoutIds)
    const payoutById = new Map((payouts ?? []).map((payout) => [Number(payout.maven_id), payout]))
    for (const row of withdrawalRows) {
      const id = payoutId(row)
      if (id == null) continue
      const payout = payoutById.get(id)
      row.matched = true
      if (!row.match_status || row.match_status === 'unmatched') row.match_status = 'auto_payout'
      row.matched_payout_id = id
      row.matched_payout_ref = payout?.ontarget_ref ?? null
      row.matched_payout_status = payout?.status ?? null
    }
  }
  const depositRows = rows.filter((row) => row.sms_category !== 'withdrawal')
  if (!depositRows.length) return
  const ids = depositRows.map((r) => r.id as number)
  const { data: links } = await db.from('sms_maven_matches').select('sms_id, tx_id').in('sms_id', ids)
  const txBySms = new Map<number, number>((links ?? []).map((l) => [l.sms_id, l.tx_id]))

  const resolveTx = (r: Record<string, unknown>): number | null => {
    const consumed = Number(r.consumed_by_tx_id)
    if (r.consumed_by_tx_id != null && Number.isFinite(consumed)) return consumed
    const fromJoin = txBySms.get(r.id as number)
    if (fromJoin != null) return fromJoin
    const direct = r.matched_transaction_id ?? r.maven_transaction_id
    const n = Number(direct)
    return direct != null && Number.isFinite(n) ? n : null
  }

  const txIds = [...new Set(depositRows.map(resolveTx).filter((v): v is number => v != null))]
  if (!txIds.length) return
  const { data: txs } = await db.from('maven_transactions').select('tx_id, ontarget_ref, currency, sub_merchant, master_merchant, gateway, receiving_wallet, to_account_number').in('tx_id', txIds)
  const refByTx = new Map((txs ?? []).map((t) => [t.tx_id, t.ontarget_ref]))

  for (const r of depositRows) {
    const txId = resolveTx(r)
    if (txId == null) continue
    // Normalize legacy rows for every API consumer. The live matcher writes
    // consumed_by_tx_id but does not consistently maintain matched/status.
    r.matched = true
    if (!r.match_status || r.match_status === 'unmatched') r.match_status = 'auto'
    r.matched_tx_id = txId
    r.matched_ontarget_ref = refByTx.get(txId) ?? null
    const tx = (txs ?? []).find((item) => Number(item.tx_id) === txId)
    r.matched_currency = tx?.currency ?? null
    r.matched_sub_merchant = tx?.sub_merchant ?? null
    r.matched_master_merchant = tx?.master_merchant ?? null
    r.matched_gateway = tx?.gateway ?? null
    r.matched_receiving_wallet = tx?.to_account_number ?? tx?.receiving_wallet ?? null
    const smsWallet = String(r.confirmed_wallet_number ?? r.wallet_number ?? r.receiver_number ?? '').replace(/\D/g, '').slice(-11)
    const txWallet = String(r.matched_receiving_wallet ?? '').replace(/\D/g, '').slice(-11)
    r.wallet_match = Boolean(smsWallet && txWallet && smsWallet === txWallet)
  }
}

// A webhook identifies the device, not necessarily the SIM. When a device has
// multiple wallet mappings and the forwarder omitted sim_slot, never present
// the newest mapping as fact: that was the source of repeated false wallet
// numbers in SMS Live. The operator can still assign the wallet explicitly.
async function markAmbiguousWallets(rows: Record<string, unknown>[]): Promise<void> {
  const devices = [...new Set(rows.map((row) => String(row.webhook_name ?? row.device_name ?? '').trim()).filter(Boolean))]
  if (!devices.length) return
  const { data } = await db.from('wallet_device_map').select('device, sim_slot, to_account_number').in('device', devices)
  const byDevice = new Map<string, { sim_slot: number | null; wallet: string }[]>()
  for (const item of data ?? []) {
    const key = String(item.device ?? '')
    const list = byDevice.get(key) ?? []
    list.push({ sim_slot: item.sim_slot == null ? null : Number(item.sim_slot), wallet: String(item.to_account_number ?? '') })
    byDevice.set(key, list)
  }
  for (const row of rows) {
    if (row.confirmed_wallet_number) continue
    const device = String(row.webhook_name ?? row.device_name ?? '').trim()
    const mappings = byDevice.get(device) ?? []
    const slot = row.sim_slot == null ? null : Number(row.sim_slot)
    const match = slot == null ? null : mappings.find((item) => item.sim_slot === slot)
    if (match) {
      row.wallet_number = match.wallet
      row.receiver_number = row.receiver_number ?? match.wallet
      continue
    }
    if (slot == null && mappings.length > 1) row.wallet_identity_ambiguous = true
  }
}

smsRoutes.get('/stats', requirePerm('sms_live', 'can_view'), async (c) => {
  const day = sinceIso(24)
  const filters: SmsFilterInput = {
    category: c.req.query('category')?.toLowerCase(),
    match: c.req.query('match')?.toLowerCase(),
    q: c.req.query('q')?.trim(),
    amount: c.req.query('amount')?.trim(),
    from: c.req.query('from')?.trim(),
    to: c.req.query('to')?.trim(),
    provider: c.req.query('provider')?.trim(),
  }

  const countWhere = async (apply: (q: any) => any) => {
    const base = applySmsFilters(db.from('inbound_sms').select('id', { count: 'exact', head: true }), filters)
    const { count, error } = await apply(base)
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  // Aggregates are disabled on PostgREST — sum the 24h window in JS.
  const volumeSince = async (category: string) => {
    let query = db
      .from('inbound_sms')
      .select('amount')
      .eq('sms_category', category)
      .limit(10_000)
    query = applySmsFilters(query, filters)
    if (!filters.from && !filters.to) query = query.gte('received_at', day)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return (data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0)
  }

  try {
    const [total, deposits, withdrawals, linked, review, depVolDay, wdVolDay] = await Promise.all([
      countWhere((q) => q),
      countWhere((q) => q.eq('sms_category', 'deposit')),
      countWhere((q) => q.eq('sms_category', 'withdrawal')),
      countWhere((q) => q.or('matched.eq.true,consumed_by_tx_id.not.is.null,matched_transaction_id.not.is.null,maven_transaction_id.not.is.null')),
      countWhere((q) => q.eq('review_required', true).eq('matched', false)),
      volumeSince('deposit'),
      volumeSince('withdrawal'),
    ])
    return c.json({
      total,
      deposits: { count: deposits, dayVolume: depVolDay },
      withdrawals: { count: withdrawals, dayVolume: wdVolDay },
      linked,
      review,
    })
  } catch (e) {
    return c.json({ error: 'db_error', detail: (e as Error).message }, 500)
  }
})

// Operator queue for the SMS↔transaction workflow. This is intentionally
// read-only: the existing matcher/link endpoints remain the only writers.
// A message is "waiting" when it has a safe identity/amount/wallet shape for
// a Maven deposit, even if the PENDING row has not arrived yet. Once a pending
// row exists, queueCandidates supplies the candidate and the UI can show it.
smsRoutes.get('/queues', requirePerm('sms_live', 'can_view'), async (c) => {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [{ data: smsRows, error: smsError }, { data: txRows, error: txError }, { data: balanceHistory, error: balanceError }] = await Promise.all([
    db.from('inbound_sms').select(LIST_COLUMNS).eq('sms_category', 'deposit').is('consumed_by_tx_id', null).is('matched_transaction_id', null).is('maven_transaction_id', null).or('is_blocked.eq.false,is_blocked.is.null').gte('received_at', since).order('received_at', { ascending: false, nullsFirst: false }).limit(1000),
    db.from('maven_transactions').select('tx_id, amount, sender_name, sender_number, receiving_wallet, to_account_number, first_seen_at').eq('status', 'PENDING').gte('first_seen_at', since).order('first_seen_at', { ascending: false, nullsFirst: false }).limit(1000),
    db.from('inbound_sms').select('id, amount, receiver_number, balance_after, received_at').not('balance_after', 'is', null).gte('received_at', since).order('received_at', { ascending: false, nullsFirst: false }).limit(10_000),
  ])
  if (smsError || txError || balanceError) return c.json({ error: 'db_error', detail: smsError?.message ?? txError?.message ?? balanceError?.message }, 500)
  const transactions = (txRows ?? []) as QueueTx[]
  const history = (balanceHistory ?? []) as unknown as QueueSms[]
  const waiting: Record<string, unknown>[] = []
  const unlinked: Record<string, unknown>[] = []
  for (const sms of (smsRows ?? []) as unknown as QueueSms[]) {
    const candidates = queueCandidates(sms, transactions, history)
    const target = candidates[0]
    const ageHours = Math.max(0, (Date.now() - (queueTime(sms.received_at) ?? Date.now())) / 3_600_000)
    const item = { ...sms, age_hours: ageHours, stale: ageHours >= 1, candidate_tx_id: target?.tx_id ?? null, candidate_count: candidates.length, match_route: phoneKey(sms.sender_number) ? 'phone_exact' : 'orange_name_amount_balance' }
    if (target || isPotentialDeposit(sms)) waiting.push(item)
    else unlinked.push(item)
  }
  return c.json({ waiting, unlinked, generated_at: new Date().toISOString() })
})

// Latest reported balance per wallet, sourced only from SMS balance_after.
smsRoutes.get('/balances', requirePerm('sms_live', 'can_view'), async (c) => {
  const { data, error } = await db.from('inbound_sms')
    .select('receiver_number, wallet_number, confirmed_wallet_number, balance_after, received_at')
    .not('balance_after', 'is', null)
    .order('received_at', { ascending: false }).limit(10_000)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const latest = new Map<string, { wallet_number: string; balance: number; received_at: string | null }>()
  for (const row of data ?? []) {
    const wallet = String(row.confirmed_wallet_number ?? row.wallet_number ?? row.receiver_number ?? '').trim()
    if (!wallet || latest.has(wallet)) continue
    const balance = Number(row.balance_after)
    if (Number.isFinite(balance)) latest.set(wallet, { wallet_number: wallet, balance, received_at: row.received_at })
  }
  return c.json({ balances: [...latest.values()] })
})

smsRoutes.get('/', requirePerm('sms_live', 'can_view'), async (c) => {
  const category = c.req.query('category')?.toLowerCase()
  const match = c.req.query('match')?.toLowerCase()
  const q = c.req.query('q')?.trim()
  const from = c.req.query('from')?.trim()
  const to = c.req.query('to')?.trim()
  const provider = c.req.query('provider')?.trim()
  // The live P2P wall requests a full month so wallet totals and the latest
  // SMS balance are correct. Keep a bounded server-side cap, while allowing
  // the existing paginated screens to continue using their smaller limits.
  const limit = Math.min(Number(c.req.query('limit')) || 25, 5000)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  let query = db
    .from('inbound_sms')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order('received_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)

  // Linked means the engine claimed it, which it records in consumed_by_tx_id.
  // Filtering on match_status instead showed only the 171 manually linked rows
  // and 76 from July: 3,888 SMS that ARE consumed still carry
  // match_status='unmatched', because nothing has maintained that column since
  // 2026-07-11. On the live TV wall that made a busy matching engine look
  // stalled for hours at a time.
  const amount = c.req.query('amount')?.trim()
  query = applySmsFilters(query, { category, match, q, amount, from, to, provider })

  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const rows = dedupeByTrxId((data ?? []) as unknown as Record<string, unknown>[])
  await markAmbiguousWallets(rows)
  await attachMatchedRef(rows)
  return c.json({ rows, total: count ?? 0, limit, offset })
})

// Manual fallback for messages that were not forwarded by a device. The row is
// explicitly marked as panel_manual so it remains auditable and distinguishable
// from device/webhook intake; it is never auto-linked on insertion.
smsRoutes.post('/manual', requirePerm('sms_live', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const message = typeof body?.message === 'string' ? body.message.trim().slice(0, 10000) : ''
  if (!message) return c.json({ error: 'message_required' }, 400)
  const category = typeof body?.sms_category === 'string' && ['deposit', 'withdrawal', 'balance', 'unknown'].includes(body.sms_category) ? body.sms_category : 'unknown'
  const amount = body?.amount == null || body.amount === '' ? null : Number(body.amount)
  if (amount != null && (!Number.isFinite(amount) || amount < 0)) return c.json({ error: 'invalid_amount' }, 400)
  const cleanPhone = (value: unknown) => typeof value === 'string' ? value.replace(/[^0-9+]/g, '').slice(0, 30) || null : null
  const senderNumber = cleanPhone(body?.sender_number)
  const receiverNumber = cleanPhone(body?.receiver_number)
  const receivedAt = typeof body?.received_at === 'string' && !Number.isNaN(Date.parse(body.received_at)) ? new Date(body.received_at).toISOString() : new Date().toISOString()
  const actor = c.get('actor')
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : null
  const payload = { ...body, _source: 'panel_manual', _entered_by: actor.username, _entered_at: new Date().toISOString() }
  const { data, error } = await db.from('inbound_sms').insert({
    message, raw_sms: message, sms_first_line: message.split(/\r?\n/)[0]?.slice(0, 500),
    sender: typeof body?.sender_name === 'string' ? body.sender_name.trim().slice(0, 160) || null : senderNumber,
    sender_name: typeof body?.sender_name === 'string' ? body.sender_name.trim().slice(0, 160) || null : null,
    sender_number: senderNumber, manual_sender_number: senderNumber,
    receiver_number: receiverNumber, manual_receiver_number: receiverNumber,
    wallet_number: receiverNumber, confirmed_wallet_number: receiverNumber,
    amount, provider: typeof body?.provider === 'string' ? body.provider.trim().slice(0, 100) || 'Manual entry' : 'Manual entry',
    trx_id: typeof body?.trx_id === 'string' ? body.trx_id.trim().slice(0, 160) || null : null,
    sms_category: category, match_status: 'unmatched', matched: false, review_required: true,
    status: 'received', suspicious: false, raw_payload: payload,
    webhook_name: 'panel_manual', import_source: 'panel_manual', manual_entry: true,
    manual_entry_by: actor.username, manual_entry_at: new Date().toISOString(), manual_entry_note: note,
    received_at: receivedAt,
  }).select('id, received_at, sms_category, amount, sender_number, receiver_number, manual_entry').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.manual_created', entity_type: 'inbound_sms', entity_id: String(data.id), after: data })
  return c.json({ ok: true, sms: data }, 201)
})

// Device chips for the live SMS rail.
smsRoutes.get('/devices', requirePerm('sms_live', 'can_view'), async (c) => {
  const { data, error } = await db
    .from('device_status')
    .select('device, sim_slot, online, battery, last_seen_at')
    .order('device')
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ devices: data ?? [] })
})

// Candidate Maven transactions for manual linking: same Cairo calendar day
// as the SMS, or an explicit ?q= ref/tx_id search still constrained to that day.
smsRoutes.get('/:id/candidates', requirePerm('sms_live', 'can_view'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const q = c.req.query('q')?.trim()

  const { data: sms, error: smsErr } = await db
    .from('inbound_sms')
    .select('id, amount, received_at, sms_category')
    .eq('id', id)
    .maybeSingle()
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category === 'withdrawal') return c.json({ candidates: [], link_type: 'wallet' })
  const smsDay = cairoDayKey(sms.received_at)
  if (!smsDay) return c.json({ candidates: [], reason: 'sms_date_missing' })

  let query = db
    .from('maven_transactions')
    .select('tx_id, ontarget_ref, status, amount, currency, sender_name, sender_number, merchant, sub_merchant, master_merchant, gateway, receiving_wallet, to_account_number, first_seen_at')
    .order('first_seen_at', { ascending: false, nullsFirst: false })
    // Fetch a wider same-day pool before sorting by proximity to the SMS.
    // Limiting at the database's newest rows could hide the transaction that
    // actually arrived beside this SMS when the queue is busy.
    .limit(100)

  if (q) {
    const ors = [`ontarget_ref.ilike.%${q}%`, `merchant_tx_reference.ilike.%${q}%`]
    if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
    query = query.or(ors.join(','))
  } else {
    if (sms.amount == null) return c.json({ candidates: [] })
    // Manual evidence linking is also useful for declined/expired decisions:
    // it preserves the audit trail and allows the recovery workflow to review
    // a late SMS. The link route never auto-approves a non-PENDING transaction.
    query = query.eq('amount', sms.amount).in('status', ['PENDING', 'PAID', 'APPROVED', 'UNDERPAID', 'DECLINED', 'EXPIRED'])
  }
  query = query.gte('first_seen_at', cairoBoundary(smsDay)).lte('first_seen_at', cairoBoundary(smsDay, true))

  const { data, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  // Only offer transactions that do not already have an SMS assigned. This
  // prevents re-linking a new message onto a transaction that is already
  // reconciled and keeps the one-SMS-per-transaction rule visible to agents.
  const candidateIds = (data ?? []).map((row) => Number(row.tx_id)).filter(Number.isFinite)
  let linkedIds = new Set<number>()
  if (candidateIds.length) {
    const { data: linkedRows } = await db.from('inbound_sms')
      .select('consumed_by_tx_id, matched_transaction_id, maven_transaction_id')
      .or(`consumed_by_tx_id.in.(${candidateIds.join(',')}),matched_transaction_id.in.(${candidateIds.join(',')}),maven_transaction_id.in.(${candidateIds.join(',')})`)
    for (const row of linkedRows ?? []) {
      for (const value of [row.consumed_by_tx_id, row.matched_transaction_id, row.maven_transaction_id]) {
        const n = Number(value)
        if (Number.isFinite(n)) linkedIds.add(n)
      }
    }
  }
  const smsTime = sms.received_at ? new Date(sms.received_at).getTime() : NaN
  const unlinkedCandidates = (data ?? [])
    .filter((row) => !linkedIds.has(Number(row.tx_id)))
    .map((row) => ({
      ...row,
      seconds_diff: Number.isFinite(smsTime) && row.first_seen_at
        ? Math.round(Math.abs(new Date(row.first_seen_at).getTime() - smsTime) / 1000)
        : null,
    }))
    .sort((a, b) => (a.seconds_diff ?? Number.MAX_SAFE_INTEGER) - (b.seconds_diff ?? Number.MAX_SAFE_INTEGER) || Number(b.tx_id) - Number(a.tx_id))
    .slice(0, 20)
  // Same client + same amount within 5 minutes, both still unlinked — the
  // classic accidental-duplicate-submission case. Flag it instead of
  // silently letting an operator pick either one.
  const ambiguous = flagAmbiguousCandidates(unlinkedCandidates.map((row) => ({
    tx_id: Number(row.tx_id), sender_number: row.sender_number, amount: row.amount, first_seen_at: row.first_seen_at,
  })))
  return c.json({ candidates: unlinkedCandidates.map((row) => ({ ...row, is_duplicate_group: ambiguous.has(Number(row.tx_id)) })) })
})

smsRoutes.post('/:id/link', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json().catch(() => null)
  const actor = c.get('actor')
  const txId = Number(body?.tx_id)
  if (!Number.isInteger(txId) || txId <= 0) return c.json({ error: 'bad_tx_id' }, 400)

  const [{ data: sms, error: smsErr }, { data: tx, error: txErr }, { data: existingTxLinks, error: linkErr }] = await Promise.all([
    db.from('inbound_sms').select('id, matched, match_status, sms_category, amount, received_at, receiver_number, wallet_number, confirmed_wallet_number, sender_name, sender_number, consumed_by_tx_id, matched_transaction_id, maven_transaction_id, is_blocked, assignment_unlocked_at, assignment_unlocked_by').eq('id', id).maybeSingle(),
    db.from('maven_transactions').select('tx_id, amount, status, gateway, sender_number, to_account_number, payment_method, first_seen_at, ontarget_ref').eq('tx_id', txId).maybeSingle(),
    db.from('inbound_sms').select('id, consumed_by_tx_id, matched_transaction_id, maven_transaction_id').or(`consumed_by_tx_id.eq.${txId},matched_transaction_id.eq.${txId},maven_transaction_id.eq.${txId}`).limit(2),
  ])
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (txErr) return c.json({ error: 'db_error', detail: txErr.message }, 500)
  if (linkErr) return c.json({ error: 'db_error', detail: linkErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category === 'withdrawal') return c.json({ error: 'withdrawal_links_to_wallet' }, 409)
  if (!tx) return c.json({ error: 'tx_not_found' }, 404)
  if (sms.matched || sms.consumed_by_tx_id != null || sms.matched_transaction_id != null || sms.maven_transaction_id != null) {
    return c.json({ error: 'already_linked' }, 409)
  }
  // A transaction may have exactly one deposit SMS. This check complements
  // the database guard below and gives operators a clear response instead of
  // silently replacing an existing evidence link.
  if ((existingTxLinks ?? []).some((link) => Number(link.id) !== Number(id))) {
    return c.json({ error: 'transaction_already_linked' }, 409)
  }

  const smsDay = cairoDayKey(sms.received_at)
  const txDay = cairoDayKey(tx.first_seen_at)
  if (!smsDay || !txDay || smsDay !== txDay) {
    return c.json({ error: 'sms_transaction_date_mismatch', sms_date: smsDay, transaction_date: txDay }, 409)
  }

  const smsAt = queueTime(sms.received_at)
  const smsAgeMs = smsAt == null ? 0 : Date.now() - smsAt
  if (smsAgeMs >= SMS_ASSIGNMENT_GRACE_MS && !sms.assignment_unlocked_at) {
    const blockReason = 'Assignment window expired after 3 hours; unblock SMS before manual linking.'
    const { error: lockError } = await db.from('inbound_sms').update({
      is_blocked: true,
      block_reason: blockReason,
      blocked_at: new Date().toISOString(),
      blocked_by: actor.username,
      review_required: false,
      assignment_unlocked_at: null,
      assignment_unlocked_by: null,
    }).eq('id', id).is('consumed_by_tx_id', null).is('matched_transaction_id', null).is('maven_transaction_id', null)
    if (lockError) return c.json({ error: 'db_error', detail: lockError.message }, 500)
    return c.json({ error: 'assignment_window_expired', requires_unblock: true, age_hours: Math.round((smsAgeMs / 3_600_000) * 100) / 100 }, 409)
  }

  const smsAmount = Number(sms.amount)
  const txAmount = Number(tx.amount)
  const amountMismatch = smsAmount !== txAmount
  if (amountMismatch && body?.confirm_amount_mismatch !== true) {
    return c.json({ error: 'amount_mismatch', sms_amount: smsAmount, tx_amount: txAmount }, 409)
  }

  const { data: claimedSms, error: updErr } = await db
    .from('inbound_sms')
    .update({
      matched: true,
      match_status: 'manual',
      matched_transaction_id: txId,
      maven_transaction_id: String(txId),
      consumed_by_tx_id: txId,
      review_required: false,
      processed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .is('consumed_by_tx_id', null)
    .is('matched_transaction_id', null)
    .is('maven_transaction_id', null)
    .select('id')
    .maybeSingle()
  if (updErr) return c.json({ error: 'db_error', detail: updErr.message }, 500)
  if (!claimedSms) return c.json({ error: 'already_linked' }, 409)

  // Keep the SMS wallet in sms_maven_matches as evidence. Never overwrite
  // Maven's receiving_wallet/to_account_number with a parsed SMS number: the
  // latter can belong to a rotated device/SIM and is not the transaction's
  // current wallet.
  const receivingWallet = sms.confirmed_wallet_number ?? sms.wallet_number ?? sms.receiver_number
  const normalizePhone = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
  const senderConfirmed = Boolean(normalizePhone(sms.sender_number) && normalizePhone(tx.sender_number) && normalizePhone(sms.sender_number) === normalizePhone(tx.sender_number))
  const walletConfirmed = Boolean(normalizePhone(receivingWallet) && normalizePhone(tx.to_account_number) && normalizePhone(receivingWallet) === normalizePhone(tx.to_account_number))

  const secDiff =
    sms.received_at && tx.first_seen_at
      ? Math.round(Math.abs(new Date(sms.received_at).getTime() - new Date(tx.first_seen_at).getTime()) / 1000)
      : null
  // Best-effort mirrors of the auto-matcher's bookkeeping — the link itself
  // already landed above.
  await db.from('sms_maven_matches').upsert(
    {
      sms_id: Number(id),
      tx_id: txId,
      receiving_wallet: receivingWallet,
      sms_amount: sms.amount,
      mv_amount: tx.amount,
      received_at: sms.received_at,
      mv_time: tx.first_seen_at,
      sec_diff: secDiff,
      webhook_name: 'panel_manual',
      matched_at: new Date().toISOString(),
    },
    { onConflict: 'sms_id' },
  )

  await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: 'sms.link',
    entity: 'inbound_sms',
    entity_id: id,
    before: { match_status: sms.match_status },
    after: { match_status: 'manual', tx_id: txId, ontarget_ref: tx.ontarget_ref, amount_mismatch: amountMismatch, sms_amount: smsAmount, tx_amount: txAmount },
  })

  // Linking an already-approved first deposit is enough evidence to remember
  // a name-only SMS identity. Pending deposits learn only after approval.
  const learnedIdentity = tx.status === 'PAID' || tx.status === 'APPROVED'
    ? await learnTrustedSmsName(txId, Number(id))
    : { learned: false, reason: 'awaiting_approved_deposit' }
  if (learnedIdentity.learned) {
    await db.from('audit_log').insert({
      actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
      action: 'crm.sms_name_learned', entity: 'maven_transactions', entity_id: String(txId),
      after: { sms_id: Number(id), purpose: 'retention_matching' },
    })
  }

  // A deliberate SMS assignment is a confirmed operator match. For a pending
  // NGPay deposit, execute the provider action immediately instead of waiting
  // for the next automation sweep. Automation remains a gate: when it is off,
  // the SMS is linked but the transaction stays pending for manual approval.
  let providerApproval: Record<string, unknown> = amountMismatch
    ? { attempted: false, skipped: 'amount_mismatch' }
    : { attempted: false }
  const gateway = String(tx.gateway ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (!amountMismatch && senderConfirmed && walletConfirmed && !isWalidCompanyMethod(tx.payment_method) && tx.status === 'PENDING' && (gateway === 'nagupayp2p' || gateway === 'nagopay')) {
    // Do not hold the SMS assignment request open while Maven performs its
    // browser action. The link is already committed; the provider action runs
    // in the platform background and updates the mirror when confirmed.
    providerApproval = { attempted: true, queued: true }
    const approvalTask = (async () => {
      const { data: settings } = await db.from('automation_settings').select('automation_enabled').eq('id', 1).maybeSingle()
      if (settings?.automation_enabled !== true) return
      const baseUrl = process.env.SUPABASE_URL
      const serviceKey = process.env.SUPABASE_SECRET_KEY
      if (!baseUrl || !serviceKey) {
        await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'sms-link-worker', action: 'sms.link_immediate_provider_approval_failed', entity: 'maven_transactions', entity_id: String(txId), after: { sms_id: Number(id), error: 'worker_not_configured' } })
        return
      }
      try {
        const response = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
          method: 'POST',
          signal: AbortSignal.timeout(45_000),
          headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
          body: JSON.stringify({ tx_id: txId, decision: 'PAID', actor_name: actor.username, remark: `Approved immediately after SMS assignment #${id}` }),
        })
        const result = await response.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
        const executed = response.ok && result.executed_on_provider === true
        if (executed) {
          const now = new Date().toISOString()
          await db.from('maven_transactions').update({ status: 'PAID', approved_by: actor.username, last_status_change: now, updated_at: now }).eq('tx_id', txId).eq('status', 'PENDING')
          await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.link_immediate_provider_approval', entity: 'maven_transactions', entity_id: String(txId), after: { sms_id: Number(id), status: 'PAID', provider_execution: true } })
        } else {
          await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'sms-link-worker', action: 'sms.link_immediate_provider_approval_failed', entity: 'maven_transactions', entity_id: String(txId), after: { sms_id: Number(id), status: response.status, result } })
        }
      } catch (error) {
        await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'sms-link-worker', action: 'sms.link_immediate_provider_approval_failed', entity: 'maven_transactions', entity_id: String(txId), after: { sms_id: Number(id), error: error instanceof Error ? error.message : 'provider_worker_failed' } })
      }
    })()
    try { c.executionCtx.waitUntil(approvalTask) } catch { approvalTask.catch(() => {}) }
  } else if (!amountMismatch && isWalidCompanyMethod(tx.payment_method)) {
    providerApproval = { attempted: false, skipped: 'walid_company_ltd_manual_only' }
    await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'sms-link-worker', action: 'sms.link_auto_approval_skipped_method', entity: 'maven_transactions', entity_id: String(txId), after: { sms_id: Number(id), payment_method: tx.payment_method } })
  } else if (!amountMismatch && tx.status === 'PENDING') {
    providerApproval = { attempted: false, skipped: 'wallet_or_sender_not_confirmed' }
    await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'sms-link-worker', action: 'sms.link_auto_approval_skipped_identity', entity: 'maven_transactions', entity_id: String(txId), after: { sms_id: Number(id), sender_confirmed: senderConfirmed, wallet_confirmed: walletConfirmed, sms_wallet: receivingWallet, tx_wallet: tx.to_account_number ?? null } })
  }

  return c.json({
    ok: true,
    learned_sms_name: learnedIdentity,
    provider_approval: providerApproval,
    amount_mismatch: amountMismatch,
    ...(amountMismatch ? {
      warning: `SMS amount (${smsAmount} EGP) does not match transaction amount (${txAmount} EGP). The SMS was linked as evidence only; the transaction was not auto-approved. Correct the transaction amount and approve it manually.`,
      sms_amount: smsAmount,
      tx_amount: txAmount,
    } : {}),
  })
})

smsRoutes.post('/:id/unlink', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)

  const { data: sms, error: smsErr } = await db
    .from('inbound_sms')
    .select('id, matched, match_status, sms_category, matched_transaction_id, maven_transaction_id, consumed_by_tx_id')
    .eq('id', id)
    .maybeSingle()
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category === 'withdrawal') return c.json({ error: 'withdrawal_links_to_wallet' }, 409)
  const linkedTxId = sms.consumed_by_tx_id ?? sms.matched_transaction_id ?? sms.maven_transaction_id
  if (!sms.matched && linkedTxId == null) return c.json({ error: 'not_linked' }, 409)

  const { error: updErr } = await db
    .from('inbound_sms')
    .update({
      matched: false,
      match_status: 'unmatched',
      matched_transaction_id: null,
      maven_transaction_id: null,
      consumed_by_tx_id: null,
      review_required: true,
    })
    .eq('id', id)
  if (updErr) return c.json({ error: 'db_error', detail: updErr.message }, 500)

  await db.from('sms_maven_matches').delete().eq('sms_id', id)

  const actor = c.get('actor')
  await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: 'sms.unlink',
    entity: 'inbound_sms',
    entity_id: id,
    before: { match_status: sms.match_status, tx_id: linkedTxId },
    after: { match_status: 'unmatched' },
  })

  return c.json({ ok: true })
})

// Block an unlinked SMS as bad/irrelevant evidence. A blocked row is excluded
// from future automatic matching and cannot be assigned until an operator
// explicitly unblocks it from the database tooling.
smsRoutes.post('/:id/block', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json().catch(() => null)
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const { data: before, error: readError } = await db.from('inbound_sms')
    .select('id, sms_category, matched, consumed_by_tx_id, matched_transaction_id, maven_transaction_id, is_blocked, block_reason, assignment_unlocked_at, assignment_unlocked_by')
    .eq('id', id).maybeSingle()
  if (readError) return c.json({ error: 'db_error', detail: readError.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.matched || before.consumed_by_tx_id != null || before.matched_transaction_id != null || before.maven_transaction_id != null) {
    return c.json({ error: 'sms_must_be_unlinked' }, 409)
  }
  if (before.is_blocked) return c.json({ error: 'already_blocked' }, 409)
  const actor = c.get('actor')
  const { data, error } = await db.from('inbound_sms').update({
    is_blocked: true,
    block_reason: reason || 'Manually blocked by operator',
    blocked_at: new Date().toISOString(),
    blocked_by: actor.username,
    review_required: false,
    assignment_unlocked_at: null,
    assignment_unlocked_by: null,
  }).eq('id', id).is('consumed_by_tx_id', null).is('matched_transaction_id', null).is('maven_transaction_id', null)
    .select('id, is_blocked, block_reason, blocked_at, blocked_by').maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'sms_must_be_unlinked' }, 409)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.blocked', entity_type: 'inbound_sms', entity_id: id, before, after: data })
  return c.json({ ok: true, sms: data })
})

smsRoutes.post('/:id/unblock', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const { data: before, error: readError } = await db.from('inbound_sms').select('id, is_blocked, block_reason, blocked_at, blocked_by, assignment_unlocked_at, assignment_unlocked_by, matched, consumed_by_tx_id, matched_transaction_id, maven_transaction_id').eq('id', id).maybeSingle()
  if (readError) return c.json({ error: 'db_error', detail: readError.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (!before.is_blocked) return c.json({ error: 'not_blocked' }, 409)
  if (before.matched || before.consumed_by_tx_id != null || before.matched_transaction_id != null || before.maven_transaction_id != null) return c.json({ error: 'sms_must_be_unlinked' }, 409)
  const { data, error } = await db.from('inbound_sms').update({ is_blocked: false, block_reason: null, blocked_at: null, blocked_by: null, assignment_unlocked_at: new Date().toISOString(), assignment_unlocked_by: c.get('actor').username, review_required: true, match_status: 'unmatched' }).eq('id', id).select('id, is_blocked, block_reason, blocked_at, blocked_by, assignment_unlocked_at, assignment_unlocked_by, review_required, match_status').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.unblocked', entity_type: 'inbound_sms', entity_id: id, before, after: data })
  return c.json({ ok: true, sms: data })
})

// Post a withdrawal SMS as an expense in the financial book, with an
// operator-supplied comment. The SMS id is an idempotency key so refreshes or
// double-clicks cannot create duplicate expense rows.
smsRoutes.post('/:id/expense', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json().catch(() => null)
  const comment = typeof body?.comment === 'string' ? body.comment.trim().slice(0, 500) : ''
  if (!comment) return c.json({ error: 'comment_required' }, 400)
  const { data: sms, error: smsError } = await db.from('inbound_sms').select('id, sms_category, amount, confirmed_wallet_number, receiver_number, wallet_number, received_at').eq('id', id).maybeSingle()
  if (smsError) return c.json({ error: 'db_error', detail: smsError.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category !== 'withdrawal') return c.json({ error: 'withdrawal_only' }, 409)
  const reference = `SMS:${id}`
  const { data: existing, error: existingError } = await db.from('financial_ledger_entries').select('id, amount, description, reference').eq('reference', reference).neq('status', 'void').maybeSingle()
  if (existingError) return c.json({ error: 'db_error', detail: existingError.message }, 500)
  if (existing) return c.json({ error: 'expense_already_recorded', entry: existing }, 409)
  const actor = c.get('actor')
  const amount = Number(sms.amount)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 422)
  const wallet = sms.confirmed_wallet_number ?? sms.wallet_number ?? sms.receiver_number ?? 'unknown wallet'
  const record = {
    entry_date: sms.received_at ? new Date(sms.received_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    entry_type: 'expense', category: 'withdrawal_sms',
    description: comment, amount, currency: 'EGP', beneficiary: wallet,
    reference, status: 'posted', created_by: actor.sub, created_by_name: actor.username,
  }
  const { data: entry, error } = await db.from('financial_ledger_entries').insert(record).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.withdrawal_expense_recorded', entity_type: 'financial_ledger_entries', entity_id: entry.id, after: { ...record, sms_id: Number(id) } })
  return c.json({ ok: true, entry }, 201)
})

// Operational annotations for withdrawal SMS. These fields already belong to
// inbound_sms; expose a narrow endpoint instead of allowing arbitrary row
// updates from the browser. Every change is attributed in audit_log.
smsRoutes.patch('/:id/withdrawal-meta', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json<{ sender_name?: unknown; notes?: unknown; wallet_number?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'invalid_body' }, 400)
  const senderName = typeof body.sender_name === 'string' ? body.sender_name.trim().slice(0, 160) : ''
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : ''
  const walletNumber = typeof body.wallet_number === 'string' ? body.wallet_number.replace(/\D/g, '').slice(0, 20) : ''
  if (!/^\d{8,20}$/.test(walletNumber)) return c.json({ error: 'invalid_wallet_number' }, 400)
  const { data: before, error: readError } = await db.from('inbound_sms')
    .select('id, sms_category, sender_name, notes, wallet_number, confirmed_wallet_number').eq('id', id).maybeSingle()
  if (readError) return c.json({ error: 'db_error', detail: readError.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.sms_category !== 'withdrawal') return c.json({ error: 'withdrawal_only' }, 409)
  const next = { sender_name: senderName || null, notes: notes || null, confirmed_wallet_number: walletNumber }
  const { data, error } = await db.from('inbound_sms').update(next).eq('id', id).eq('sms_category', 'withdrawal')
    .select('id, sender_name, notes, confirmed_wallet_number').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'sms.withdrawal_meta_updated', entity_type: 'inbound_sms', entity_id: id,
    before: { sender_name: before.sender_name, notes: before.notes, confirmed_wallet_number: before.confirmed_wallet_number, extracted_wallet_number: before.wallet_number }, after: next,
  })
  return c.json({ ok: true, sms: data })
})

// Operator annotation for an unlinked SMS (for example, "Extra fund"). The
// operational SMS category remains intact; this stores a human classification
// and note without making the message look automatically reconciled.
smsRoutes.patch('/:id/annotation', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json<{ category?: unknown; notes?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'invalid_body' }, 400)
  const category = typeof body.category === 'string' ? body.category.trim().slice(0, 120) : ''
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : ''
  const { data: before, error: readError } = await db.from('inbound_sms').select('id, matched_tx_id, consumed_by_tx_id, manual_entry_note, notes').eq('id', id).maybeSingle()
  if (readError) return c.json({ error: 'db_error', detail: readError.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.matched_tx_id != null || before.consumed_by_tx_id != null) return c.json({ error: 'sms_must_be_unlinked' }, 409)
  const next = { manual_entry_note: category || null, notes: notes || null }
  const { data, error } = await db.from('inbound_sms').update(next).eq('id', id).select('id, manual_entry_note, notes').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.unlinked_annotation_updated', entity_type: 'inbound_sms', entity_id: id, before: { category: before.manual_entry_note, notes: before.notes }, after: { category, notes } })
  return c.json({ ok: true, sms: data })
})

smsRoutes.post('/:id/withdrawal-assignment', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  const assignmentType = typeof body?.assignment_type === 'string' ? body.assignment_type : ''
  const targetReference = typeof body?.target_reference === 'string' ? body.target_reference.trim().slice(0, 160) : ''
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 160) : ''
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : ''
  if (!['payout', 'p2p_usdt', 'cash_return', 'mina_cash'].includes(assignmentType)) return c.json({ error: 'invalid_assignment_type' }, 400)
  if (!name) return c.json({ error: 'name_required' }, 400)
  const [{ data: sms, error: smsError }, { data: existingAssignment, error: assignmentLookupError }] = await Promise.all([
    db.from('inbound_sms').select('id, sms_category, amount, receiver_number, trx_id, trx_reference, message, consumed_by_tx_id, matched_transaction_id, maven_transaction_id, matched').eq('id', id).maybeSingle(),
    db.from('sms_withdrawal_assignments').select('sms_id').eq('sms_id', Number(id)).maybeSingle(),
  ])
  if (smsError) return c.json({ error: 'db_error', detail: smsError.message }, 500)
  if (assignmentLookupError) return c.json({ error: 'db_error', detail: assignmentLookupError.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category !== 'withdrawal') return c.json({ error: 'withdrawal_only' }, 409)
  if (sms.consumed_by_tx_id != null || sms.matched_transaction_id != null || sms.maven_transaction_id != null || sms.matched || existingAssignment) {
    return c.json({ error: 'already_linked' }, 409)
  }

  let payoutId: number | null = null
  let payout: { maven_id: number; ontarget_ref: string | null; amount: number | null; mobile_no: string | null; status: string | null; matched_sms_id: number | null } | null = null
  if (assignmentType === 'payout') {
    if (!targetReference) return c.json({ error: 'target_reference_required' }, 400)
    let payoutQuery = db.from('maven_payout_transactions').select('maven_id, ontarget_ref, amount, mobile_no, status, matched_sms_id')
    payoutQuery = /^\d+$/.test(targetReference)
      ? payoutQuery.or(`maven_id.eq.${targetReference},ontarget_ref.eq.${targetReference}`)
      : payoutQuery.eq('ontarget_ref', targetReference)
    const { data: foundPayout, error } = await payoutQuery.maybeSingle()
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    if (!foundPayout) return c.json({ error: 'payout_not_found' }, 404)
    payout = foundPayout
    if (payout.matched_sms_id != null && Number(payout.matched_sms_id) !== Number(id)) return c.json({ error: 'payout_already_linked' }, 409)
    payoutId = Number(payout.maven_id)
  }

  const actor = c.get('actor')
  const assignment = { sms_id: Number(id), assignment_type: assignmentType, target_reference: targetReference || null, display_name: name, note: note || null, assigned_by: actor.username, assigned_by_id: actor.sub, assigned_at: new Date().toISOString() }
  const { error: assignmentError } = await db.from('sms_withdrawal_assignments').upsert(assignment, { onConflict: 'sms_id' })
  if (assignmentError) return c.json({ error: 'db_error', detail: assignmentError.message }, 500)
  if (payoutId != null) {
    const { error: smsLinkError } = await db.from('inbound_sms').update({ consumed_by_tx_id: payoutId, matched_transaction_id: payoutId, matched: true, match_status: 'manual_payout', sender_name: name, notes: note || null }).eq('id', id)
    if (smsLinkError) return c.json({ error: 'db_error', detail: smsLinkError.message }, 500)
    const { error: payoutLinkError } = await db.from('maven_payout_transactions').update({ matched_sms_id: Number(id) }).eq('maven_id', payoutId)
    if (payoutLinkError) return c.json({ error: 'db_error', detail: payoutLinkError.message }, 500)
    const assignedPayout = payout
    const exactMatch = Boolean(assignedPayout)
      && Number(assignedPayout?.amount) === Number(sms.amount)
      && phoneKey(assignedPayout?.mobile_no ?? null) !== ''
      && phoneKey(assignedPayout?.mobile_no ?? null) === phoneKey(sms.receiver_number)
    const autoApproval = exactMatch && assignedPayout?.status === 'PENDING'
      ? await autoApproveMatchedPayout(payoutId, sms, actor.username).catch((error) => ({ attempted: true, executed_on_provider: false, error: error instanceof Error ? error.message : 'auto_approval_failed' }))
      : { attempted: false, reason: exactMatch ? 'payout_not_pending' : 'amount_or_destination_mismatch' }
    await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'payout.sms_proof_auto_approval', entity_type: 'maven_payout_transactions', entity_id: String(payoutId), after: { sms_id: Number(id), exact_match: exactMatch, result: autoApproval } })
    return c.json({ ok: true, assignment, auto_approval: autoApproval })
  } else {
    const { error: metaError } = await db.from('inbound_sms').update({ sender_name: name, notes: note || null, matched: true, match_status: `manual_${assignmentType}` }).eq('id', id)
    if (metaError) return c.json({ error: 'db_error', detail: metaError.message }, 500)
  }
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'sms.withdrawal_assigned', entity_type: 'inbound_sms', entity_id: id, after: assignment })
  return c.json({ ok: true, assignment })
})

smsRoutes.get('/:id', requirePerm('sms_live', 'can_view'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const { data, error } = await db
    .from('inbound_sms')
    .select(
      `${LIST_COLUMNS}, wallet, notes, assigned_operator, risk_score, risk_reason, is_duplicate, maven_guid, manual_entry, manual_entry_by, manual_entry_note, created_at`,
    )
    .eq('id', id)
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  const rows = [data as unknown as Record<string, unknown>]
  await attachMatchedRef(rows)
  return c.json({ sms: rows[0] })
})
