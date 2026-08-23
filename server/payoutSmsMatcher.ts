import { db } from './db.js'

type Candidate = { id: number; amount: number | null; receiver_number: string | null; received_at: string | null }
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
    db.from('inbound_sms').select('id, amount, receiver_number, received_at')
      .eq('sms_category', 'withdrawal').is('consumed_by_tx_id', null).gte('received_at', since)
      .order('received_at', { ascending: false }).limit(limit * 2),
  ])
  if (payoutErr) throw new Error(`payout lookup: ${payoutErr.message}`)
  if (smsErr) throw new Error(`withdrawal SMS lookup: ${smsErr.message}`)

  const ps = (payouts ?? []) as Payout[]
  const ss = (messages ?? []) as Candidate[]
  const pairCandidates = ps.map((payout) => {
    const at = payout.first_seen_at ? Date.parse(payout.first_seen_at) : NaN
    return { payout, matches: ss.filter((sms) => Number(sms.amount) === Number(payout.amount)
      && phone(sms.receiver_number) !== '' && phone(sms.receiver_number) === phone(payout.mobile_no)
      && Number.isFinite(at) && sms.received_at != null && Math.abs(Date.parse(sms.received_at) - at) <= 86_400_000) }
  })
  const smsUseCount = new Map<number, number>()
  for (const pair of pairCandidates) for (const sms of pair.matches) smsUseCount.set(sms.id, (smsUseCount.get(sms.id) ?? 0) + 1)

  let linked = 0
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
  return { scannedPayouts: ps.length, scannedSms: ss.length, linked }
}
