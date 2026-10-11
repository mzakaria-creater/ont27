import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Late-SMS match proposals.
//
// A deposit is auto-declined ~5 minutes after it appears. Two things slip past
// the automation: (1) the customer's transfer SMS reaches us AFTER that
// (slow transfer, device backlog) and nothing re-checks the declined
// transaction; (2) an SMS that carries no sender identity (name only, device
// not mapped to a wallet) which the identity-based matcher cannot safely pair.
// public.propose_late_sms_matches() (pg_cron, every minute) finds both kinds --
//   tier 1: same sender identity (phone, or CRM-learned name) + exact amount;
//   tier 2: exact amount + time only, and ONLY when nothing else on the whole
//           platform shares that amount within 5 minutes --
// and writes a PENDING proposal. It never approves anything. This route is the
// human half: the operator sees the proposal in a popup and answers Yes (link
// the SMS and approve; allow_reversal covers an already-declined tx) or No
// (remembered, never asked again for that pair).

export const lateSmsMatchRoutes = new Hono<AuthEnv>()
lateSmsMatchRoutes.use('*', requireAuth)

const COLUMNS = 'id, tx_id, sms_id, ontarget_ref, amount, sender_number, wallet, merchant, tx_created_at, sms_received_at, delay_seconds, sms_sender_name, match_basis, sms_blocked, status, created_at'
const STATUSES = new Set(['pending', 'approved', 'rejected', 'failed', 'expired'])

lateSmsMatchRoutes.get('/', requirePerm('deposits', 'can_view'), async (c) => {
  const status = c.req.query('status') ?? 'pending'
  if (!STATUSES.has(status)) return c.json({ error: 'bad_status' }, 400)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100)
  const { data, error } = await db.from('late_sms_match_proposals')
    .select(COLUMNS)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [] })
})

lateSmsMatchRoutes.post('/:id/decide', requirePerm('deposits', 'can_approve'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json().catch(() => null) as { decision?: string } | null
  const decision = body?.decision
  if (decision !== 'approve' && decision !== 'reject') return c.json({ error: 'bad_decision' }, 400)

  const actor = c.get('actor')
  const now = () => new Date().toISOString()
  const audit = (action: string, entityId: string, after: Record<string, unknown>) =>
    db.from('audit_log').insert({
      actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
      action, entity: 'late_sms_match_proposals', entity_id: entityId, after,
    })

  // Claim the proposal first so a double click (or two operators) cannot run
  // the approval twice. It is released back to 'pending' if execution fails.
  const { data: claimed, error: claimError } = await db.from('late_sms_match_proposals')
    .update({ status: decision === 'reject' ? 'rejected' : 'approved', decided_by: actor.username, decided_at: now() })
    .eq('id', id).eq('status', 'pending')
    .select(COLUMNS)
    .maybeSingle()
  if (claimError) return c.json({ error: 'db_error', detail: claimError.message }, 500)
  if (!claimed) return c.json({ error: 'already_decided' }, 409)

  if (decision === 'reject') {
    await audit('late_match.reject', id, { tx_id: claimed.tx_id, sms_id: claimed.sms_id })
    return c.json({ ok: true, decision: 'reject' })
  }

  const release = async (note: string) => {
    await db.from('late_sms_match_proposals')
      .update({ status: 'pending', decided_by: null, decided_at: null, decision_note: note })
      .eq('id', id)
  }

  const txId = Number(claimed.tx_id)
  const smsId = Number(claimed.sms_id)

  const [{ data: tx }, { data: sms }] = await Promise.all([
    db.from('maven_transactions').select('tx_id, status, amount, gateway').eq('tx_id', txId).maybeSingle(),
    db.from('inbound_sms').select('id, amount, is_blocked, block_reason, consumed_by_tx_id, matched_transaction_id, maven_transaction_id, confirmed_wallet_number, wallet_number, receiver_number, received_at')
      .eq('id', smsId).maybeSingle(),
  ])
  if (!tx || (tx.status !== 'DECLINED' && tx.status !== 'PENDING')) {
    await db.from('late_sms_match_proposals').update({ status: 'expired', decision_note: `transaction is ${tx?.status ?? 'missing'}, not DECLINED or PENDING` }).eq('id', id)
    return c.json({ error: 'transaction_not_open', status: tx?.status ?? null }, 409)
  }
  if (!sms || sms.consumed_by_tx_id != null || sms.matched_transaction_id != null || sms.maven_transaction_id != null) {
    await db.from('late_sms_match_proposals').update({ status: 'expired', decision_note: 'sms already linked elsewhere' }).eq('id', id)
    return c.json({ error: 'sms_already_linked' }, 409)
  }
  if (Number(sms.amount) !== Number(tx.amount)) {
    await release('amount_changed')
    return c.json({ error: 'amount_mismatch', sms_amount: Number(sms.amount), tx_amount: Number(tx.amount) }, 409)
  }

  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) {
    await release('worker_not_configured')
    return c.json({ error: 'worker_not_configured' }, 500)
  }

  // The SMS may carry the 3-hour assignment lock. The operator's explicit Yes
  // is the unlock, recorded the same way the panel's Unblock action records it.
  if (sms.is_blocked) {
    if (!String(sms.block_reason ?? '').startsWith('Assignment window expired')) {
      await release('sms_blocked_for_other_reason')
      return c.json({ error: 'sms_blocked', reason: sms.block_reason ?? null }, 409)
    }
    await db.from('inbound_sms').update({
      is_blocked: false, block_reason: null, assignment_unlocked_at: now(), assignment_unlocked_by: actor.username,
    }).eq('id', smsId).is('consumed_by_tx_id', null)
  }

  const { data: linked, error: linkError } = await db.from('inbound_sms').update({
    matched: true, match_status: 'manual_late_match', matched_transaction_id: txId, maven_transaction_id: String(txId),
    consumed_by_tx_id: txId, review_required: false, processed_at: now(),
    notes: `late SMS match approved from popup by ${actor.username} (proposal #${id})`,
  }).eq('id', smsId).is('consumed_by_tx_id', null).is('matched_transaction_id', null).is('maven_transaction_id', null)
    .select('id').maybeSingle()
  if (linkError || !linked) {
    await release(linkError ? `link_failed: ${linkError.message}` : 'sms_claimed_by_someone_else')
    return c.json({ error: linkError ? 'db_error' : 'already_linked', detail: linkError?.message }, linkError ? 500 : 409)
  }

  const unlink = () => db.from('inbound_sms').update({
    matched: false, match_status: 'unmatched', matched_transaction_id: null, maven_transaction_id: null, consumed_by_tx_id: null,
  }).eq('id', smsId).eq('consumed_by_tx_id', txId)

  let result: Record<string, unknown> = {}
  let executed = false
  try {
    const response = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
      method: 'POST',
      signal: AbortSignal.timeout(50_000),
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        tx_id: txId, decision: 'PAID', actor_name: actor.username, allow_reversal: true, source: 'late_sms_match',
        remark: `Late SMS match approved by operator (SMS #${smsId}, proposal #${id}, ${claimed.match_basis})`,
      }),
    })
    result = await response.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
    executed = response.ok && result.executed_on_provider === true
  } catch (error) {
    result = { error: error instanceof Error ? error.message : 'provider_worker_failed' }
  }

  if (!executed) {
    await unlink()
    await release(`provider_failed: ${String(result.error ?? 'not executed')}`.slice(0, 300))
    await audit('late_match.approve_failed', id, { tx_id: txId, sms_id: smsId, result })
    return c.json({ error: 'provider_not_executed', result }, 502)
  }

  const stamp = now()
  await db.from('maven_transactions')
    .update({ status: 'PAID', approved_by: actor.username, last_status_change: stamp, updated_at: stamp })
    .eq('tx_id', txId).eq('status', tx.status)
  const receivingWallet = sms.confirmed_wallet_number ?? sms.wallet_number ?? sms.receiver_number ?? null
  await db.from('sms_maven_matches').upsert({
    sms_id: smsId, tx_id: txId, receiving_wallet: receivingWallet, sms_amount: sms.amount, mv_amount: tx.amount,
    received_at: sms.received_at, mv_time: claimed.tx_created_at, sec_diff: Math.abs(Number(claimed.delay_seconds ?? 0)),
    webhook_name: 'late_sms_match', matched_at: stamp,
  }, { onConflict: 'sms_id' })
  await db.from('late_sms_match_proposals').update({ decision_note: 'approved on provider' }).eq('id', id)
  await audit('late_match.approve', id, { tx_id: txId, sms_id: smsId, executed_on_provider: true, match_basis: claimed.match_basis })
  return c.json({ ok: true, decision: 'approve', executed_on_provider: true })
})
