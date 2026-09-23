import { db } from './db.js'
import { notifyApprovedTransaction } from './approvalEmail.js'
import { isWalidCompanyMethod } from './autoApprovalPolicy.js'

type SmsRow = { id: number; trx_id: string | null; amount: number | null; sender_name: string | null; sender_number: string | null; received_at: string | null; receiver_number: string | null; wallet_number?: string | null; confirmed_wallet_number?: string | null; balance_after?: number | null; provider?: string | null; sms_sender?: string | null; raw_sms?: string | null; message?: string | null; is_blocked?: boolean | null }
type TxRow = { tx_id: number; guid: string | null; ontarget_ref: string | null; merchant_tx_reference: string | null; amount: number | null; sender_name: string | null; sender_number: string | null; receiving_wallet: string | null; to_account_number: string | null; payment_method: string | null; gateway: string | null; status: string | null; first_seen_at: string | null }

const PAGE = 1000
const MAX_LINKS_PER_RUN = 250
const MAX_TIME_DIFF_MS = 7 * 86_400_000
const FALLBACK_TIME_DIFF_MS = 10 * 60_000
const ref = (value: unknown) => String(value ?? '').trim().toUpperCase()
const cents = (value: unknown) => Math.round(Number(value) * 100)
const phone = (value: unknown) => { const digits = String(value ?? '').replace(/\D/g, ''); return digits.length > 10 ? digits.slice(-10) : digits }
// Several Orange SMS providers omit sender_number but append the sender phone
// to sender_name (for example "Name-01202909766"). Treat that embedded phone
// as identity evidence; otherwise every such message is silently unmatchable.
const embeddedPhone = (value: unknown) => {
  const match = String(value ?? '').match(/01\d{9}/)
  return match?.[0] ?? ''
}
const NETWORK_SOURCE_RE = /orange\s*cash|orange\s*money|اورنچ\s*كاش|اورنج\s*كاش|vodafone\s*cash|vf[- ]?cash|فودافون\s*كاش|alex\s*bank|alexbank|بنك\s*الاسكندرية|insta\s*pay|instapay|انستا\s*باي|انستاباي/i
const PHONE_SENDER_HEADER_RE = /^\s*from\s*:\s*\+?\d[\d\s-]{7,}/im
const isNetworkProviderSms = (sms: SmsRow) => {
  const text = `${sms.sms_sender ?? ''} ${sms.provider ?? ''} ${sms.raw_sms ?? ''} ${sms.message ?? ''}`
  return !PHONE_SENDER_HEADER_RE.test(text) && NETWORK_SOURCE_RE.test(text)
}
const receivingWallet = (sms: SmsRow) => sms.confirmed_wallet_number ?? sms.wallet_number ?? sms.receiver_number
const nameKey = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((part) => part.length > 1).join(' ')
const sameName = (left: unknown, right: unknown) => { const a = nameKey(left); const b = nameKey(right); return Boolean(a && b && (a === b || a.includes(b) || b.includes(a))) }
function hasBalanceContinuity(sms: SmsRow, history: SmsRow[]) {
  const wallet = phone(receivingWallet(sms))
  const at = Date.parse(String(sms.received_at ?? ''))
  const balance = Number(sms.balance_after)
  const amount = Number(sms.amount)
  if (!wallet || !Number.isFinite(at) || !Number.isFinite(balance) || !Number.isFinite(amount)) return false
  const previous = history.filter((row) => row.id !== sms.id && phone(receivingWallet(row)) === wallet && Number.isFinite(Number(row.balance_after)) && Date.parse(String(row.received_at ?? '')) < at).sort((a, b) => Date.parse(String(b.received_at ?? '')) - Date.parse(String(a.received_at ?? '')))[0]
  return Boolean(previous && Math.abs(balance - (Number(previous.balance_after) + amount)) <= 1)
}

export interface PaidSmsRepairResult {
  scannedSms: number
  scannedTransactions: number
  eligible: number
  linked: number
  autoApproved: number
  skippedAmbiguous: number
  skippedAlreadyAssigned: number
  errors: string[]
  diagnostics: { noAmountCandidate: number; noUsableTime: number; outsideTenMinutes: number; missingSenderName: number; senderNameMismatch: number; ambiguousFallback: number; ownWalletSender: number }
  sample: { sms_id: number; tx_id: number; trx_id: string; sec_diff: number | null }[]
}

// Assigns an SMS to a transaction. For a clean unique match, a pending live
// NGPay transaction is also approved by the provider worker when automation
// is enabled; the worker must confirm the provider result before mirroring
// PAID locally.
// deliberately stricter than the operator candidate search: amount alone is
// never enough. The receiving wallet is the primary discriminator. A link
// requires exact amount + wallet, a bounded time window and a unique result.
export async function repairPaidSmsMatches(apply: boolean, scanLimit = PAGE): Promise<PaidSmsRepairResult> {
  const limit = Math.min(Math.max(scanLimit, 1), PAGE)
  const [{ data: smsData, error: smsError }, { data: txData, error: txError }] = await Promise.all([
    db.from('inbound_sms')
      .select('id, trx_id, amount, sender_name, sender_number, received_at, receiver_number, wallet_number, confirmed_wallet_number, balance_after, provider, sms_sender, raw_sms, message')
      .eq('sms_category', 'deposit')
      .is('consumed_by_tx_id', null)
      .or('is_blocked.eq.false,is_blocked.is.null')
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    db.from('maven_transactions')
      .select('tx_id, guid, ontarget_ref, merchant_tx_reference, amount, sender_name, sender_number, receiving_wallet, to_account_number, payment_method, gateway, status, first_seen_at')
      // Declined rows are included for late-evidence recovery. They are
      // always review-only below and can never be auto-approved.
      .in('status', ['PENDING', 'PAID', 'APPROVED', 'DECLINED'])
      .order('first_seen_at', { ascending: false, nullsFirst: false })
      .limit(limit),
  ])
  if (smsError) throw new Error(`sms scan: ${smsError.message}`)
  if (txError) throw new Error(`transaction scan: ${txError.message}`)

  const { data: walletRows, error: walletError } = await db.from('wallet_device_map').select('to_account_number')
  if (walletError) throw new Error(`wallet exclusion lookup: ${walletError.message}`)
  const { data: balanceHistory, error: balanceHistoryError } = await db.from('inbound_sms').select('id, amount, receiver_number, wallet_number, confirmed_wallet_number, balance_after, received_at').not('balance_after', 'is', null).or('is_blocked.eq.false,is_blocked.is.null').gte('received_at', new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(10_000)
  if (balanceHistoryError) throw new Error(`balance continuity lookup: ${balanceHistoryError.message}`)
  const ourWallets = new Set((walletRows ?? []).map((row) => phone(row.to_account_number)).filter(Boolean))
  const smsRows = (smsData ?? []) as SmsRow[]
  const txRows = (txData ?? []) as TxRow[]
  const txByRef = new Map<string, TxRow[]>()
  for (const tx of txRows) {
    for (const key of new Set([ref(tx.tx_id), ref(tx.guid), ref(tx.ontarget_ref), ref(tx.merchant_tx_reference)].filter(Boolean))) {
      txByRef.set(key, [...(txByRef.get(key) ?? []), tx])
    }
  }

  const txIds = txRows.map((tx) => tx.tx_id)
  const assignedTx = new Set<number>()
  for (let i = 0; i < txIds.length; i += 200) {
    const chunk = txIds.slice(i, i + 200)
    const [matches, consumed] = await Promise.all([
      db.from('sms_maven_matches').select('tx_id').in('tx_id', chunk),
      db.from('inbound_sms').select('consumed_by_tx_id').in('consumed_by_tx_id', chunk),
    ])
    if (matches.error) throw new Error(`existing matches: ${matches.error.message}`)
    if (consumed.error) throw new Error(`existing consumed links: ${consumed.error.message}`)
    for (const row of matches.data ?? []) assignedTx.add(Number(row.tx_id))
    for (const row of consumed.data ?? []) assignedTx.add(Number(row.consumed_by_tx_id))
  }

  const proposals: { sms: SmsRow; tx: TxRow; secDiff: number | null; requiresReview: boolean }[] = []
  let skippedAmbiguous = 0
  let skippedAlreadyAssigned = 0
  const diagnostics = { noAmountCandidate: 0, noUsableTime: 0, outsideTenMinutes: 0, missingSenderName: 0, senderNameMismatch: 0, ambiguousFallback: 0, ownWalletSender: 0 }
  for (const sms of smsRows) {
    // Only bank/wallet-network notifications are automation evidence. A
    // customer-phone SMS remains visible for review but cannot auto-match.
    if (!isNetworkProviderSms(sms)) continue
    if (ourWallets.has(phone(sms.sender_number))) { diagnostics.ownWalletSender++; continue }
    const smsRawPhone = String(sms.sender_number || embeddedPhone(sms.sender_name)).replace(/\D/g, '')
    const smsPhone = phone(smsRawPhone)
    const smsWallet = phone(receivingWallet(sms))
    const byAmount = txRows.filter((tx) => cents(tx.amount) === cents(sms.amount))
    if (!byAmount.length) { diagnostics.noAmountCandidate++; continue }
    const byEvidence = byAmount.filter((tx) => {
      const txWallet = phone(tx.receiving_wallet ?? tx.to_account_number)
      const walletMatch = Boolean(txWallet && smsWallet && txWallet === smsWallet)
      if (smsPhone && phone(tx.sender_number) && phone(tx.sender_number) !== smsPhone) return false
      const method = String(tx.payment_method ?? '').toLowerCase()
      const orange = /orange/i.test(`${sms.provider ?? ''} ${sms.message ?? ''} ${sms.raw_sms ?? ''} ${method}`)
      // Orange Cash commonly omits the sender phone. In that case the safe
      // identity path is name + amount + wallet + time + balance continuity.
      if (!smsPhone && (!orange || !sameName(sms.sender_name, tx.sender_name) || !hasBalanceContinuity(sms, (balanceHistory ?? []) as SmsRow[]))) return false
      // Instant approval requires the wallet to match as well as the sender.
      // A rotated/legacy wallet is handled by the review-only fallback below;
      // it must never reach the provider trigger as an instant decision.
      if (!walletMatch) return false
      // Orange Cash sender identities are 012-based when a number is present.
      if (method.includes('orange') && smsPhone && !/^012/.test(smsRawPhone)) return false
      if (!tx.first_seen_at || !sms.received_at) return false
      const delta = Math.abs(Date.parse(tx.first_seen_at) - Date.parse(sms.received_at))
      const maxDelta = txByRef.has(ref(sms.trx_id)) ? MAX_TIME_DIFF_MS : FALLBACK_TIME_DIFF_MS
      return Number.isFinite(delta) && delta <= maxDelta
    })
    // Wallet rotations and provider rows that lag one assignment behind are
    // common. When the strict wallet/name path cannot prove a strong match,
    // retain a unique amount+time+balance candidate for human review. This
    // prevents the SMS from disappearing while deliberately avoiding any
    // instant provider decision. A known sender mismatch is still a hard stop.
    const byReviewEvidence = byAmount.filter((tx) => {
      const txPhone = phone(tx.sender_number)
      if (smsPhone && txPhone && smsPhone !== txPhone) return false
      const txWallet = phone(tx.receiving_wallet ?? tx.to_account_number)
      const walletMatch = Boolean(txWallet && smsWallet && txWallet === smsWallet)
      // The database SMS-link trigger can approve when both sender numbers
      // match. Do not let a wallet-rotation fallback reach that trigger.
      if (smsPhone && txPhone && !walletMatch && tx.status !== 'DECLINED') return false
      if (smsPhone && txPhone && !smsWallet) return false
      if (!tx.first_seen_at || !sms.received_at) return false
      const delta = Math.abs(Date.parse(tx.first_seen_at) - Date.parse(sms.received_at))
      const maxDelta = txByRef.has(ref(sms.trx_id)) ? MAX_TIME_DIFF_MS : FALLBACK_TIME_DIFF_MS
      if (!Number.isFinite(delta) || delta > maxDelta) return false
      if (walletMatch) return true
      // Without a wallet match, balance continuity is the minimum evidence
      // needed to distinguish a real deposit from a same-amount coincidence.
      return hasBalanceContinuity(sms, (balanceHistory ?? []) as SmsRow[])
    })
    // Prefer an explicit bank reference only when the wallet/phone evidence
    // still agrees. Otherwise the same strict wallet+amount+time rule applies.
    const referenced = new Set((txByRef.get(ref(sms.trx_id)) ?? []).map((tx) => tx.tx_id))
    let requiresReview = false
    let candidates = byEvidence.filter((tx) => referenced.size === 0 || referenced.has(tx.tx_id))
    if (referenced.size > 0 && candidates.length === 0) candidates = byEvidence
    if (candidates.length === 0) {
      candidates = byReviewEvidence.filter((tx) => referenced.size === 0 || referenced.has(tx.tx_id))
      if (referenced.size > 0 && candidates.length === 0) candidates = byReviewEvidence
      requiresReview = candidates.length > 0
    }
    if (!candidates.length) {
      if (!sms.received_at || !Number.isFinite(Date.parse(sms.received_at))) diagnostics.noUsableTime++
      else diagnostics.outsideTenMinutes++
    } else if (candidates.length > 1) diagnostics.ambiguousFallback++
    if (candidates.length !== 1) { if (candidates.length > 1) skippedAmbiguous++; continue }
    if (assignedTx.has(candidates[0].tx_id)) { skippedAlreadyAssigned++; continue }
    const tx = candidates[0]
    const secDiff = sms.received_at && tx.first_seen_at ? Math.round(Math.abs(Date.parse(sms.received_at) - Date.parse(tx.first_seen_at)) / 1000) : null
    proposals.push({ sms, tx, secDiff, requiresReview: requiresReview || tx.status === 'DECLINED' })
  }

  // A transaction may still be proposed by duplicate SMS rows. Keep none of
  // them: choosing one would silently invent evidence.
  const proposalCount = new Map<number, number>()
  for (const p of proposals) proposalCount.set(p.tx.tx_id, (proposalCount.get(p.tx.tx_id) ?? 0) + 1)
  const unique = proposals.filter((p) => proposalCount.get(p.tx.tx_id) === 1).slice(0, MAX_LINKS_PER_RUN)
  skippedAmbiguous += proposals.length - unique.length

  const errors: string[] = []
  let linked = 0
  let autoApproved = 0
  let automationEnabled = false
  if (apply) {
    const { data: settings, error: settingsError } = await db.from('automation_settings').select('automation_enabled').eq('id', 1).maybeSingle()
    if (settingsError) throw new Error(`automation settings: ${settingsError.message}`)
    automationEnabled = settings?.automation_enabled === true
  }
  if (apply) {
    for (let i = 0; i < unique.length; i += 10) {
      await Promise.all(unique.slice(i, i + 10).map(async ({ sms, tx, secDiff, requiresReview }) => {
        const now = new Date().toISOString()
        const { data: claimed, error: claimError } = await db.from('inbound_sms').update({
          matched: true,
          match_status: requiresReview ? 'auto_review' : 'auto',
          matched_transaction_id: tx.tx_id,
          maven_transaction_id: String(tx.tx_id),
          consumed_by_tx_id: tx.tx_id,
          review_required: requiresReview,
          processed_at: now,
        }).eq('id', sms.id).is('consumed_by_tx_id', null).select('id')
        if (claimError || !claimed?.length) { errors.push(`sms ${sms.id}: ${claimError?.message ?? 'already claimed'}`); return }

        const [match, wallet] = await Promise.all([
          db.from('sms_maven_matches').upsert({
            sms_id: sms.id, tx_id: tx.tx_id, receiving_wallet: receivingWallet(sms),
            sms_amount: sms.amount, mv_amount: tx.amount, received_at: sms.received_at,
            mv_time: tx.first_seen_at, sec_diff: secDiff, webhook_name: requiresReview ? 'trx_unique_review_match' : 'trx_exact_auto_match', matched_at: now,
          }, { onConflict: 'sms_id' }),
          !requiresReview && receivingWallet(sms) ? db.from('maven_transactions').update({ receiving_wallet: receivingWallet(sms) }).eq('tx_id', tx.tx_id) : Promise.resolve({ error: null }),
        ])
        if (match.error) errors.push(`match ${sms.id}/${tx.tx_id}: ${match.error.message}`)
        if (wallet.error) errors.push(`wallet tx ${tx.tx_id}: ${wallet.error.message}`)
        if (!match.error) {
          linked++

          // A clean, unique SMS match is sufficient evidence to approve a
          // pending live NGPay deposit. The provider worker verifies the
          // action on Maven; only then do we mirror PAID locally. Other
          // gateways remain linked for manual handling because this worker
          // must never mark a provider transaction paid without confirmation.
          const gateway = String(tx.gateway ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
          if (!requiresReview && automationEnabled && !isWalidCompanyMethod(tx.payment_method) && tx.status === 'PENDING' && (gateway === 'nagupayp2p' || gateway === 'nagopay')) {
            const baseUrl = process.env.SUPABASE_URL
            const serviceKey = process.env.SUPABASE_SECRET_KEY
            if (!baseUrl || !serviceKey) { errors.push(`auto approve ${tx.tx_id}: worker_not_configured`); return }
            try {
              const response = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
                method: 'POST',
                signal: AbortSignal.timeout(45_000),
                headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
                body: JSON.stringify({ tx_id: tx.tx_id, decision: 'PAID', actor_name: 'Auto', remark: `Approved automatically after verified SMS match #${sms.id}` }),
              })
              const result = await response.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
              if (!response.ok || result.executed_on_provider !== true) {
                errors.push(`auto approve ${tx.tx_id}: ${String(result.error ?? `HTTP ${response.status}`)}`)
                return
              }
              const nowApproved = new Date().toISOString()
              const { error: mirrorError } = await db.from('maven_transactions').update({ status: 'PAID', approved_by: 'Auto', last_status_change: nowApproved, updated_at: nowApproved }).eq('tx_id', tx.tx_id).eq('status', 'PENDING')
              if (mirrorError) errors.push(`auto approve mirror ${tx.tx_id}: ${mirrorError.message}`)
              await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'Auto', action: 'deposit.auto_approve_sms_match', entity: 'maven_transactions', entity_id: String(tx.tx_id), before: { status: 'PENDING' }, after: { status: 'PAID', sms_id: sms.id, provider_execution: true } })
              await notifyApprovedTransaction({ ...tx, status: 'PAID', approved_by: 'Auto', approved_at: nowApproved, provider_confirmed: true })
              autoApproved++
            } catch (error) {
              errors.push(`auto approve ${tx.tx_id}: ${error instanceof Error ? error.message : 'worker_failed'}`)
            }
          }
        }
      }))
    }
  }

  return {
    scannedSms: smsRows.length,
    scannedTransactions: txRows.length,
    eligible: unique.length,
    linked,
    autoApproved,
    skippedAmbiguous,
    skippedAlreadyAssigned,
    errors: errors.slice(0, 20),
    diagnostics,
    sample: unique.slice(0, 20).map(({ sms, tx, secDiff }) => ({ sms_id: sms.id, tx_id: tx.tx_id, trx_id: sms.trx_id ?? '', sec_diff: secDiff })),
  }
}
