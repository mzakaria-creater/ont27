import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// SMS Live = inbound_sms (device-forwarded wallet SMS). The panel surfaces the
// live queue + its Maven transaction links, mirroring the old "SMS operations
// center" tab. Read-only for now — manual linking is a later flow.

export const smsRoutes = new Hono<AuthEnv>()

smsRoutes.use('*', requireAuth)

const LIST_COLUMNS =
  'id, received_at, device_name, sim_slot, sender_number, sender_name, receiver_number, amount, balance_after, sms_category, match_status, matched, review_required, trx_id, matched_transaction_id, maven_transaction_id, provider, sms_first_line'

function sinceIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

// Resolve each matched SMS to the ontarget_ref of its transaction, so the UI
// can show the same identifier the deposits/transactions views show instead of
// a bare tx_id that an operator has to look up by hand.
//
// Three link sources with different coverage — sms_maven_matches is by far the
// richest (1,315 rows vs 150 in matched_transaction_id and 100 in
// maven_transaction_id), so it wins, with the two columns as fallbacks.
async function attachMatchedRef(rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return
  const ids = rows.map((r) => r.id as number)
  const { data: links } = await db.from('sms_maven_matches').select('sms_id, tx_id').in('sms_id', ids)
  const txBySms = new Map<number, number>((links ?? []).map((l) => [l.sms_id, l.tx_id]))

  const resolveTx = (r: Record<string, unknown>): number | null => {
    const fromJoin = txBySms.get(r.id as number)
    if (fromJoin != null) return fromJoin
    const direct = r.matched_transaction_id ?? r.maven_transaction_id
    const n = Number(direct)
    return direct != null && Number.isFinite(n) ? n : null
  }

  const txIds = [...new Set(rows.map(resolveTx).filter((v): v is number => v != null))]
  if (!txIds.length) return
  const { data: txs } = await db.from('maven_transactions').select('tx_id, ontarget_ref').in('tx_id', txIds)
  const refByTx = new Map((txs ?? []).map((t) => [t.tx_id, t.ontarget_ref]))

  for (const r of rows) {
    const txId = resolveTx(r)
    if (txId == null) continue
    r.matched_tx_id = txId
    r.matched_ontarget_ref = refByTx.get(txId) ?? null
  }
}

smsRoutes.get('/stats', requirePerm('sms_live', 'can_view'), async (c) => {
  const day = sinceIso(24)

  const countWhere = async (apply: (q: any) => any) => {
    const { count, error } = await apply(
      db.from('inbound_sms').select('id', { count: 'exact', head: true }),
    )
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  // Aggregates are disabled on PostgREST — sum the 24h window in JS.
  const volumeSince = async (category: string) => {
    const { data, error } = await db
      .from('inbound_sms')
      .select('amount')
      .eq('sms_category', category)
      .gte('received_at', day)
      .limit(10_000)
    if (error) throw new Error(error.message)
    return (data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0)
  }

  try {
    const [total, deposits, withdrawals, linked, review, depVolDay, wdVolDay] = await Promise.all([
      countWhere((q) => q),
      countWhere((q) => q.eq('sms_category', 'deposit')),
      countWhere((q) => q.eq('sms_category', 'withdrawal')),
      countWhere((q) => q.neq('match_status', 'unmatched')),
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
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  let query = db
    .from('inbound_sms')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order('received_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)

  if (category) query = query.eq('sms_category', category)
  if (match === 'linked') query = query.neq('match_status', 'unmatched')
  else if (match === 'unmatched') query = query.eq('match_status', 'unmatched')
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

  // Exact-amount lookup (used by the deposits 🔎 "find SMS" shortcut) —
  // kept separate from q so numeric id searches stay precise.
  const amount = c.req.query('amount')?.trim()
  if (amount && /^\d+(\.\d+)?$/.test(amount)) query = query.eq('amount', amount)

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
    .select('id, amount, received_at')
    .eq('id', id)
    .maybeSingle()
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)

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
    db.from('inbound_sms').select('id, matched, match_status, amount, received_at, receiver_number').eq('id', id).maybeSingle(),
    db.from('maven_transactions').select('tx_id, amount, first_seen_at, ontarget_ref').eq('tx_id', txId).maybeSingle(),
  ])
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (txErr) return c.json({ error: 'db_error', detail: txErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (!tx) return c.json({ error: 'tx_not_found' }, 404)
  if (sms.matched) return c.json({ error: 'already_linked' }, 409)

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

  return c.json({ ok: true })
})

smsRoutes.post('/:id/unlink', requirePerm('sms_live', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  if (!/^\d+$/.test(id)) return c.json({ error: 'bad_id' }, 400)

  const { data: sms, error: smsErr } = await db
    .from('inbound_sms')
    .select('id, matched, match_status, matched_transaction_id')
    .eq('id', id)
    .maybeSingle()
  if (smsErr) return c.json({ error: 'db_error', detail: smsErr.message }, 500)
  if (!sms) return c.json({ error: 'not_found' }, 404)
  if (!sms.matched) return c.json({ error: 'not_linked' }, 409)

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
    before: { match_status: sms.match_status, tx_id: sms.matched_transaction_id },
    after: { match_status: 'unmatched' },
  })

  return c.json({ ok: true })
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
  return c.json({ sms: data })
})
