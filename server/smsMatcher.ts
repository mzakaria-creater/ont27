import { db } from './db.js'

type SmsRow = { id: number; trx_id: string | null; amount: number | null; sender_name: string | null; sender_number: string | null; received_at: string | null; receiver_number: string | null }
type TxRow = { tx_id: number; guid: string | null; ontarget_ref: string | null; merchant_tx_reference: string | null; amount: number | null; sender_name: string | null; sender_number: string | null; receiving_wallet: string | null; to_account_number: string | null; first_seen_at: string | null }

const PAGE = 1000
const MAX_LINKS_PER_RUN = 250
const MAX_TIME_DIFF_MS = 7 * 86_400_000
const FALLBACK_TIME_DIFF_MS = 10 * 60_000
const ref = (value: unknown) => String(value ?? '').trim().toUpperCase()
const cents = (value: unknown) => Math.round(Number(value) * 100)
const name = (value: unknown) => String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')
const phone = (value: unknown) => { const digits = String(value ?? '').replace(/\D/g, ''); return digits.length > 10 ? digits.slice(-10) : digits }

export interface PaidSmsRepairResult {
  scannedSms: number
  scannedTransactions: number
  eligible: number
  linked: number
  skippedAmbiguous: number
  skippedAlreadyAssigned: number
  errors: string[]
  diagnostics: { noAmountCandidate: number; noUsableTime: number; outsideTenMinutes: number; missingSenderName: number; senderNameMismatch: number; ambiguousFallback: number }
  sample: { sms_id: number; tx_id: number; trx_id: string; sec_diff: number | null }[]
}

// Assigns an SMS to a transaction without changing the transaction status.
// PENDING must be included: assignment is evidence for the automation/review
// decision, so waiting until a transaction is already PAID made the matcher
// circular and useless to the live decision path.
// deliberately stricter than the operator candidate search: amount alone is
// never enough. A link requires an exact transaction reference, exact amount,
// a seven-day time bound, and a unique one-to-one result.
export async function repairPaidSmsMatches(apply: boolean, scanLimit = PAGE): Promise<PaidSmsRepairResult> {
  const limit = Math.min(Math.max(scanLimit, 1), PAGE)
  const [{ data: smsData, error: smsError }, { data: txData, error: txError }] = await Promise.all([
    db.from('inbound_sms')
      .select('id, trx_id, amount, sender_name, sender_number, received_at, receiver_number')
      .eq('sms_category', 'deposit')
      .is('consumed_by_tx_id', null)
      .not('trx_id', 'is', null)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    db.from('maven_transactions')
      .select('tx_id, guid, ontarget_ref, merchant_tx_reference, amount, sender_name, sender_number, receiving_wallet, to_account_number, first_seen_at')
      .in('status', ['PENDING', 'PAID', 'APPROVED'])
      .order('first_seen_at', { ascending: false, nullsFirst: false })
      .limit(limit),
  ])
  if (smsError) throw new Error(`sms scan: ${smsError.message}`)
  if (txError) throw new Error(`transaction scan: ${txError.message}`)

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

  const proposals: { sms: SmsRow; tx: TxRow; secDiff: number | null }[] = []
  let skippedAmbiguous = 0
  let skippedAlreadyAssigned = 0
  const diagnostics = { noAmountCandidate: 0, noUsableTime: 0, outsideTenMinutes: 0, missingSenderName: 0, senderNameMismatch: 0, ambiguousFallback: 0 }
  for (const sms of smsRows) {
    let candidates = [...new Map((txByRef.get(ref(sms.trx_id)) ?? []).map((tx) => [tx.tx_id, tx])).values()]
      .filter((tx) => cents(tx.amount) === cents(sms.amount))
      .filter((tx) => {
        if (!tx.first_seen_at || !sms.received_at) return true
        return Math.abs(Date.parse(tx.first_seen_at) - Date.parse(sms.received_at)) <= MAX_TIME_DIFF_MS
      })
    // Bank TRX ids are often not copied into Maven's merchant reference. The
    // only automatic fallback allowed is exact amount + exact normalized
    // sender name + a tight 10-minute window, and it still must resolve to one
    // transaction and one SMS. Amount-only matching remains forbidden.
    if (candidates.length === 0) {
      const byAmount = txRows.filter((tx) => cents(tx.amount) === cents(sms.amount))
      if (!byAmount.length) diagnostics.noAmountCandidate++
      else if (!sms.received_at || !Number.isFinite(Date.parse(sms.received_at))) diagnostics.noUsableTime++
      else {
        const smsAt = Date.parse(sms.received_at)
        const byTime = byAmount.filter((tx) => tx.first_seen_at != null && Number.isFinite(Date.parse(tx.first_seen_at))
          && Math.abs(Date.parse(tx.first_seen_at) - smsAt) <= FALLBACK_TIME_DIFF_MS)
        if (!byTime.length) diagnostics.outsideTenMinutes++
        else {
          // Prefer the strongest bank evidence: exact normalized sender phone,
          // exact receiving wallet, amount and a tight time window. Name-only
          // remains a fallback for bank SMS that genuinely contains no phone.
          const smsPhone = phone(sms.sender_number)
          const smsWallet = phone(sms.receiver_number)
          if (smsPhone) candidates = byTime.filter((tx) => phone(tx.sender_number) === smsPhone && (!smsWallet || phone(tx.receiving_wallet ?? tx.to_account_number) === smsWallet))
          else if (!name(sms.sender_name)) diagnostics.missingSenderName++
          else candidates = byTime.filter((tx) => name(tx.sender_name) === name(sms.sender_name))
          if (!candidates.length) diagnostics.senderNameMismatch++
          else if (candidates.length > 1) diagnostics.ambiguousFallback++
        }
      }
    }
    if (candidates.length !== 1) { if (candidates.length > 1) skippedAmbiguous++; continue }
    if (assignedTx.has(candidates[0].tx_id)) { skippedAlreadyAssigned++; continue }
    const tx = candidates[0]
    const secDiff = sms.received_at && tx.first_seen_at ? Math.round(Math.abs(Date.parse(sms.received_at) - Date.parse(tx.first_seen_at)) / 1000) : null
    proposals.push({ sms, tx, secDiff })
  }

  // A transaction may still be proposed by duplicate SMS rows. Keep none of
  // them: choosing one would silently invent evidence.
  const proposalCount = new Map<number, number>()
  for (const p of proposals) proposalCount.set(p.tx.tx_id, (proposalCount.get(p.tx.tx_id) ?? 0) + 1)
  const unique = proposals.filter((p) => proposalCount.get(p.tx.tx_id) === 1).slice(0, MAX_LINKS_PER_RUN)
  skippedAmbiguous += proposals.length - unique.length

  const errors: string[] = []
  let linked = 0
  if (apply) {
    for (let i = 0; i < unique.length; i += 10) {
      await Promise.all(unique.slice(i, i + 10).map(async ({ sms, tx, secDiff }) => {
        const now = new Date().toISOString()
        const { data: claimed, error: claimError } = await db.from('inbound_sms').update({
          matched: true,
          match_status: 'auto',
          matched_transaction_id: tx.tx_id,
          maven_transaction_id: String(tx.tx_id),
          consumed_by_tx_id: tx.tx_id,
          review_required: false,
          processed_at: now,
        }).eq('id', sms.id).is('consumed_by_tx_id', null).select('id')
        if (claimError || !claimed?.length) { errors.push(`sms ${sms.id}: ${claimError?.message ?? 'already claimed'}`); return }

        const [match, wallet] = await Promise.all([
          db.from('sms_maven_matches').upsert({
            sms_id: sms.id, tx_id: tx.tx_id, receiving_wallet: sms.receiver_number,
            sms_amount: sms.amount, mv_amount: tx.amount, received_at: sms.received_at,
            mv_time: tx.first_seen_at, sec_diff: secDiff, webhook_name: 'trx_exact_auto_match', matched_at: now,
          }, { onConflict: 'sms_id' }),
          sms.receiver_number ? db.from('maven_transactions').update({ receiving_wallet: sms.receiver_number }).eq('tx_id', tx.tx_id) : Promise.resolve({ error: null }),
        ])
        if (match.error) errors.push(`match ${sms.id}/${tx.tx_id}: ${match.error.message}`)
        if (wallet.error) errors.push(`wallet tx ${tx.tx_id}: ${wallet.error.message}`)
        if (!match.error) linked++
      }))
    }
  }

  return {
    scannedSms: smsRows.length,
    scannedTransactions: txRows.length,
    eligible: unique.length,
    linked,
    skippedAmbiguous,
    skippedAlreadyAssigned,
    errors: errors.slice(0, 20),
    diagnostics,
    sample: unique.slice(0, 20).map(({ sms, tx, secDiff }) => ({ sms_id: sms.id, tx_id: tx.tx_id, trx_id: sms.trx_id ?? '', sec_diff: secDiff })),
  }
}
