import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'
import { learnTrustedSmsName } from './clientIdentity.js'

// SMS Live = inbound_sms (device-forwarded wallet SMS). The panel surfaces the
// live queue + its Maven transaction links, mirroring the old "SMS operations
// center" tab. Read-only for now — manual linking is a later flow.

export const smsRoutes = new Hono<AuthEnv>()

smsRoutes.use('*', requireAuth)

const LIST_COLUMNS =
  'id, received_at, device_name, sim_slot, sender_number, sender_name, receiver_number, wallet_number, confirmed_wallet_number, amount, balance_after, sms_category, match_status, matched, review_required, trx_id, matched_transaction_id, maven_transaction_id, consumed_by_tx_id, provider, sms_first_line'

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
}

// Keep the list and KPI cards on one definition of "filtered SMS". This is
// deliberately shared: adding a filter to the table without adding it to the
// cards was the reason their numbers previously looked stale/wrong.
function applySmsFilters(query: any, filters: SmsFilterInput) {
  const { category, match, q, amount, from, to } = filters
  if (category) query = query.eq('sms_category', category)
  if (from) query = query.gte('received_at', `${from}T00:00:00Z`)
  if (to) query = query.lte('received_at', `${to}T23:59:59.999Z`)
  if (match === 'linked') query = query.or('and(sms_category.neq.withdrawal,consumed_by_tx_id.not.is.null),and(sms_category.eq.withdrawal,wallet_number.not.is.null)')
  else if (match === 'unmatched') query = query.or('and(sms_category.neq.withdrawal,consumed_by_tx_id.is.null),and(sms_category.eq.withdrawal,wallet_number.is.null)')
  else if (match === 'review') query = query.eq('review_required', true).eq('matched', false)

  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [
      `sender_name.ilike.${like}`,
      `sender_number.ilike.${like}`,
      `receiver_number.ilike.${like}`,
      `trx_id.ilike.${like}`,
      `device_name.ilike.${like}`,
      `provider.ilike.${like}`,
    ]
    if (/^\d+$/.test(q)) ors.push(`id.eq.${q}`)
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
  const { data: txs } = await db.from('maven_transactions').select('tx_id, ontarget_ref').in('tx_id', txIds)
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
      Promise.all([
        countWhere((q) => q.neq('sms_category', 'withdrawal').not('consumed_by_tx_id', 'is', null)),
        countWhere((q) => q.eq('sms_category', 'withdrawal').not('wallet_number', 'is', null)),
      ]).then(([depositLinks, walletLinks]) => depositLinks + walletLinks),
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

smsRoutes.get('/', requirePerm('sms_live', 'can_view'), async (c) => {
  const category = c.req.query('category')?.toLowerCase()
  const match = c.req.query('match')?.toLowerCase()
  const q = c.req.query('q')?.trim()
  const from = c.req.query('from')?.trim()
  const to = c.req.query('to')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
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
  query = applySmsFilters(query, { category, match, q, amount, from, to })

  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  await attachMatchedRef(rows)
  return c.json({ rows, total: count ?? 0, limit, offset })
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

// Candidate maven_transactions for manual linking: same amount within ±3 days
// of the SMS, or an explicit ?q= ref/tx_id search.
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

  let query = db
    .from('maven_transactions')
    .select('tx_id, ontarget_ref, status, amount, currency, sender_name, sender_number, merchant, first_seen_at')
    .order('first_seen_at', { ascending: false, nullsFirst: false })
    .limit(10)

  if (q) {
    const ors = [`ontarget_ref.ilike.%${q}%`, `merchant_tx_reference.ilike.%${q}%`]
    if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
    query = query.or(ors.join(','))
  } else {
    if (sms.amount == null) return c.json({ candidates: [] })
    query = query.eq('amount', sms.amount).in('status', ['PENDING', 'PAID', 'APPROVED', 'UNDERPAID'])
    if (sms.received_at) {
      const t = new Date(sms.received_at).getTime()
      query = query
        .gte('first_seen_at', new Date(t - 3 * 86_400_000).toISOString())
        .lte('first_seen_at', new Date(t + 3 * 86_400_000).toISOString())
    }
  }

  const { data, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ candidates: data ?? [] })
})

smsRoutes.post('/:id/link', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json().catch(() => null)
  const txId = Number(body?.tx_id)
  if (!Number.isInteger(txId) || txId <= 0) return c.json({ error: 'bad_tx_id' }, 400)

  const [{ data: sms, error: smsErr }, { data: tx, error: txErr }] = await Promise.all([
    db.from('inbound_sms').select('id, matched, match_status, sms_category, amount, received_at, receiver_number, sender_name, sender_number, consumed_by_tx_id, matched_transaction_id, maven_transaction_id').eq('id', id).maybeSingle(),
    db.from('maven_transactions').select('tx_id, amount, status, sender_number, first_seen_at, ontarget_ref').eq('tx_id', txId).maybeSingle(),
  ])
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (txErr) return c.json({ error: 'db_error', detail: txErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category === 'withdrawal') return c.json({ error: 'withdrawal_links_to_wallet' }, 409)
  if (!tx) return c.json({ error: 'tx_not_found' }, 404)
  if (sms.matched || sms.consumed_by_tx_id != null || sms.matched_transaction_id != null || sms.maven_transaction_id != null) {
    return c.json({ error: 'already_linked' }, 409)
  }

  const { error: updErr } = await db
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
  if (updErr) return c.json({ error: 'db_error', detail: updErr.message }, 500)

  // A matched SMS is the authoritative evidence of the wallet that received
  // the funds.  Do not overwrite to_account_number: it records the original
  // checkout allocation and is useful for diagnosing a mismatch.
  if (sms.receiver_number) {
    const { error: walletError } = await db
      .from('maven_transactions')
      .update({ receiving_wallet: sms.receiver_number })
      .eq('tx_id', txId)
    if (walletError) return c.json({ error: 'db_error', detail: walletError.message }, 500)
  }

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
      receiving_wallet: sms.receiver_number,
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

  const actor = c.get('actor')
  await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: 'sms.link',
    entity: 'inbound_sms',
    entity_id: id,
    before: { match_status: sms.match_status },
    after: { match_status: 'manual', tx_id: txId, ontarget_ref: tx.ontarget_ref },
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

  return c.json({ ok: true, learned_sms_name: learnedIdentity })
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

smsRoutes.post('/:id/withdrawal-assignment', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  const assignmentType = typeof body?.assignment_type === 'string' ? body.assignment_type : ''
  const targetReference = typeof body?.target_reference === 'string' ? body.target_reference.trim().slice(0, 160) : ''
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 160) : ''
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : ''
  if (!['payout', 'p2p_usdt', 'cash_return'].includes(assignmentType)) return c.json({ error: 'invalid_assignment_type' }, 400)
  if (!name) return c.json({ error: 'name_required' }, 400)
  const { data: sms, error: smsError } = await db.from('inbound_sms').select('id, sms_category, consumed_by_tx_id').eq('id', id).maybeSingle()
  if (smsError) return c.json({ error: 'db_error', detail: smsError.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (sms.sms_category !== 'withdrawal') return c.json({ error: 'withdrawal_only' }, 409)

  let payoutId: number | null = null
  if (assignmentType === 'payout') {
    if (!targetReference) return c.json({ error: 'target_reference_required' }, 400)
    let payoutQuery = db.from('maven_payout_transactions').select('maven_id, ontarget_ref, matched_sms_id')
    payoutQuery = /^\d+$/.test(targetReference)
      ? payoutQuery.or(`maven_id.eq.${targetReference},ontarget_ref.eq.${targetReference}`)
      : payoutQuery.eq('ontarget_ref', targetReference)
    const { data: payout, error } = await payoutQuery.maybeSingle()
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    if (!payout) return c.json({ error: 'payout_not_found' }, 404)
    if (sms.consumed_by_tx_id != null && Number(sms.consumed_by_tx_id) !== Number(payout.maven_id)) return c.json({ error: 'already_linked' }, 409)
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
      `${LIST_COLUMNS}, message, sms_sender, wallet, notes, assigned_operator, risk_score, risk_reason, is_duplicate, maven_guid, manual_entry, manual_entry_by, manual_entry_note, created_at`,
    )
    .eq('id', id)
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  const rows = [data as unknown as Record<string, unknown>]
  await attachMatchedRef(rows)
  return c.json({ sms: rows[0] })
})
