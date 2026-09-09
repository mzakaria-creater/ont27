import { db } from './db.js'

type Candidate = { id: number; amount: number | null; receiver_number: string | null; received_at: string | null; consumed_by_tx_id: number | null; matched?: boolean | null; message?: string | null; sender_name?: string | null; notes?: string | null; manual_entry_note?: string | null }
type Payout = { maven_id: number; amount: number | null; mobile_no: string | null; first_seen_at: string | null }

const phone = (value: string | null) => (value ?? '').replace(/\D/g, '').replace(/^20(?=1\d{9}$)/, '0')

// Evidence-only matching. It never changes payout/provider status. A match is
// accepted only when amount + recipient phone identify exactly one unused WD
// SMS and one unlinked payout inside the same 24-hour window.
export async function autoLinkWithdrawalSms(limit = 300) {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const [{ data: payouts, error: payoutErr }, { data: messages, error: smsErr }] = await Promise.all([
    db.from('maven_payout_transactions').select('maven_id, amount, mobile_no, first_seen_at')
      .is('matched_sms_id', null).gte('first_seen_at', since).order('first_seen_at', { ascending: false }).limit(limit),
    db.from('inbound_sms').select('id, amount, receiver_number, received_at, consumed_by_tx_id, matched, message, sender_name, notes, manual_entry_note')
      .eq('sms_category', 'withdrawal').gte('received_at', since)
      .or('is_blocked.eq.false,is_blocked.is.null')
      .order('received_at', { ascending: false }).limit(limit * 2),
  ])
  if (payoutErr) throw new Error(`payout lookup: ${payoutErr.message}`)
  if (smsErr) throw new Error(`withdrawal SMS lookup: ${smsErr.message}`)

  const ps = (payouts ?? []) as Payout[]
  const ss = (messages ?? []) as Candidate[]
  let linked = 0
  const repairedPayouts = new Set<number>()
  for (const sms of ss) {
    if (sms.consumed_by_tx_id == null) continue
    const payout = ps.find((row) => row.maven_id === Number(sms.consumed_by_tx_id)
      && Number(row.amount) === Number(sms.amount) && phone(row.mobile_no) === phone(sms.receiver_number))
    if (!payout) continue
    const { data: repaired, error } = await db.from('maven_payout_transactions').update({ matched_sms_id: sms.id })
      .eq('maven_id', payout.maven_id).is('matched_sms_id', null).select('maven_id').maybeSingle()
    if (error) throw new Error(`repair payout ${payout.maven_id}: ${error.message}`)
    if (repaired) { repairedPayouts.add(payout.maven_id); linked += 1 }
  }

  const availableSms = ss.filter((sms) => sms.consumed_by_tx_id == null)
  const pairCandidates = ps.filter((payout) => !repairedPayouts.has(payout.maven_id)).map((payout) => {
    const at = payout.first_seen_at ? Date.parse(payout.first_seen_at) : NaN
    return { payout, matches: availableSms.filter((sms) => Number(sms.amount) === Number(payout.amount)
      && phone(sms.receiver_number) !== '' && phone(sms.receiver_number) === phone(payout.mobile_no)
      && Number.isFinite(at) && sms.received_at != null && Math.abs(Date.parse(sms.received_at) - at) <= 86_400_000) }
  })
  const smsUseCount = new Map<number, number>()
  for (const pair of pairCandidates) for (const sms of pair.matches) smsUseCount.set(sms.id, (smsUseCount.get(sms.id) ?? 0) + 1)

  for (const { payout, matches } of pairCandidates) {
    if (matches.length !== 1 || smsUseCount.get(matches[0].id) !== 1) continue
    const sms = matches[0]
    const { data: claimed, error } = await db.from('inbound_sms')
      .update({ consumed_by_tx_id: payout.maven_id, matched_transaction_id: payout.maven_id, matched: true,
        match_status: 'auto_payout', auto_match_score: 100, processed_at: new Date().toISOString() })
      .eq('id', sms.id).is('consumed_by_tx_id', null).select('id').maybeSingle()
    if (error) throw new Error(`claim SMS ${sms.id}: ${error.message}`)
    if (!claimed) continue
    const { data: assigned, error: assignErr } = await db.from('maven_payout_transactions')
      .update({ matched_sms_id: sms.id }).eq('maven_id', payout.maven_id).is('matched_sms_id', null).select('maven_id').maybeSingle()
    if (assignErr || !assigned) {
      await db.from('inbound_sms').update({ consumed_by_tx_id: null, matched_transaction_id: null, matched: false,
        match_status: 'unmatched', auto_match_score: null }).eq('id', sms.id).eq('consumed_by_tx_id', payout.maven_id)
      if (assignErr) throw new Error(`assign payout ${payout.maven_id}: ${assignErr.message}`)
      continue
    }
    linked += 1
  }

  // Deterministic fallback classification for withdrawal SMS that are not a
  // payout: only explicit USDT/expense wording is eligible. Ambiguous SMS stay
  // unlinked for an operator, so the matcher never invents a financial target.
  const classified = ss.filter((sms) => sms.consumed_by_tx_id == null && !sms.matched && !repairedPayouts.has(Number(sms.consumed_by_tx_id)))
  for (const sms of classified) {
    const text = `${sms.message ?? ''} ${sms.notes ?? ''} ${sms.manual_entry_note ?? ''}`.toLowerCase()
    const usdt = /\busdt\b|tether|p2p\s*crypto|بينانس|تيثر/.test(text)
    const mina = /(^|[^a-z])mina([^a-z]|$)/i.test(sms.sender_name ?? '') || /(^|[^a-z])mina([^a-z]|$)/i.test(text)
    const assignmentType = usdt ? 'p2p_usdt' : /expense|مصروف|مصاريف|expense\s*withdrawal/.test(text) ? 'cash_return' : null
    if (!assignmentType) continue
    // Mina USDT SMS are routed to the named MINA P2P group and Ahmed's queue.
    // The assignment remains idempotent and only claims an unlinked SMS.
    const minaUsdt = assignmentType === 'p2p_usdt' && mina
    const displayName = minaUsdt ? 'MINA' : sms.sender_name?.trim() || (assignmentType === 'p2p_usdt' ? 'USDT P2P' : 'Wallet expense')
    const assignmentReference = minaUsdt ? 'MINA' : null
    const smsUpdate: Record<string, unknown> = { matched: true, match_status: `auto_${assignmentType}`, auto_match_score: 100, processed_at: new Date().toISOString() }
    if (minaUsdt) smsUpdate.assigned_operator = 'Ahmed'
    const { data: claimed, error: claimErr } = await db.from('inbound_sms').update(smsUpdate).eq('id', sms.id).is('consumed_by_tx_id', null).select('id').maybeSingle()
    if (claimErr) throw new Error(`classify SMS ${sms.id}: ${claimErr.message}`)
    if (!claimed) continue
    const { error: assignmentErr } = await db.from('sms_withdrawal_assignments').upsert({ sms_id: sms.id, assignment_type: assignmentType, target_reference: assignmentReference, display_name: displayName, note: sms.notes ?? sms.manual_entry_note ?? null, assigned_by: 'automation', assigned_at: new Date().toISOString() }, { onConflict: 'sms_id' })
    if (assignmentErr) throw new Error(`assign SMS ${sms.id}: ${assignmentErr.message}`)
    await db.from('audit_log').insert({ actor_type: 'system', actor_name: 'withdrawal-sms-matcher', action: `sms.withdrawal_auto_${assignmentType}`, entity_type: 'inbound_sms', entity_id: String(sms.id), after: { assignment_type: assignmentType, amount: sms.amount } })
    linked += 1
  }
  return { scannedPayouts: ps.length, scannedSms: ss.length, linked }
}
