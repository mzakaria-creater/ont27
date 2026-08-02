import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Deposits = maven_transactions (ground truth for the deposit flow).
// Real statuses observed in panel-v2 data: PENDING | PAID | APPROVED |
// DECLINED | EXPIRED | EXPIRED_LOCAL | UNDERPAID — never assume only three.
// created_utc/modified_utc are TEXT in two formats; first_seen_at /
// last_status_change (timestamptz) are the reliable time columns.

export const depositRoutes = new Hono<AuthEnv>()

depositRoutes.use('*', requireAuth)

const LIST_COLUMNS =
  'tx_id, guid, ontarget_ref, merchant_tx_reference, status, amount, currency, sender_name, sender_number, payment_method, gateway, merchant, sub_merchant, master_merchant, manual_entry, approved_by, first_seen_at, last_status_change, created_utc'

const DECISION_TARGET: Record<string, string> = {
  approve: 'PAID',
  decline: 'DECLINED',
}

function sinceIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

depositRoutes.get('/stats', requirePerm('dashboard', 'can_view'), async (c) => {
  const day = sinceIso(24)
  const week = sinceIso(24 * 7)

  const countByStatus = async (status?: string) => {
    let q = db.from('maven_transactions').select('tx_id', { count: 'exact', head: true })
    if (status) q = q.eq('status', status)
    const { count, error } = await q
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  // Aggregates are disabled on PostgREST, so sum small windows in JS.
  const volumeSince = async (iso: string, statuses: string[]) => {
    const { data, error } = await db
      .from('maven_transactions')
      .select('amount, status')
      .in('status', statuses)
      .gte('first_seen_at', iso)
      .limit(10_000)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    return {
      count: rows.length,
      volume: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    }
  }

  const [total, pending, paidDay, declinedDay, paidWeek, recent] = await Promise.all([
    countByStatus(),
    countByStatus('PENDING'),
    volumeSince(day, ['PAID', 'APPROVED']),
    volumeSince(day, ['DECLINED']).then((v) => v.count),
    volumeSince(week, ['PAID', 'APPROVED']),
    db
      .from('maven_transactions')
      .select(LIST_COLUMNS)
      .order('ontarget_ref', { ascending: false, nullsFirst: false })
      .limit(10)
      .then(({ data, error }) => {
        if (error) throw new Error(error.message)
        return data ?? []
      }),
  ])

  return c.json({
    total,
    pending,
    day: { paid: paidDay, declined: declinedDay },
    week: { paid: paidWeek },
    recent,
  })
})

depositRoutes.get('/', requirePerm('deposits', 'can_view'), async (c) => {
  const status = c.req.query('status')?.toUpperCase()
  const master = c.req.query('master')?.trim()
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  let query = db
    .from('maven_transactions')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order('ontarget_ref', { ascending: false, nullsFirst: false })
    .order('tx_id', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (master) query = query.ilike('master_merchant', `%${master}%`)
  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [
      `ontarget_ref.ilike.${like}`,
      `sender_number.ilike.${like}`,
      `sender_name.ilike.${like}`,
      `merchant.ilike.${like}`,
      `guid.ilike.${like}`,
    ]
    if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
    query = query.or(ors.join(','))
  }

  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0, limit, offset })
})

depositRoutes.get('/:txId', requirePerm('deposits', 'can_view'), async (c) => {
  const txId = c.req.param('txId')
  if (!/^\d+$/.test(txId)) return c.json({ error: 'bad_tx_id' }, 400)
  const { data, error } = await db
    .from('maven_transactions')
    .select('*')
    .eq('tx_id', txId)
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)

  // Matched SMS (if the matcher or an operator linked one) + client history.
  const [smsMatch, clientRows] = await Promise.all([
    db
      .from('sms_maven_matches')
      .select('sms_id, sec_diff, matched_at')
      .eq('tx_id', txId)
      .maybeSingle()
      .then(async ({ data: m }) => {
        if (!m) return null
        const { data: sms } = await db
          .from('inbound_sms')
          .select('id, received_at, device_name, sim_slot, sender_name, sender_number, amount, balance_after, sms_first_line, match_status')
          .eq('id', m.sms_id)
          .maybeSingle()
        return sms ? { ...sms, sec_diff: m.sec_diff } : null
      }),
    data.sender_number
      ? db
          .from('maven_transactions')
          .select('status')
          .eq('sender_number', data.sender_number)
          .limit(1_000)
          .then(({ data: rows }) => rows ?? [])
      : Promise.resolve([]),
  ])

  const client = data.sender_number
    ? {
        total: clientRows.length,
        paid: clientRows.filter((r) => r.status === 'PAID' || r.status === 'APPROVED').length,
        declined: clientRows.filter((r) => r.status === 'DECLINED').length,
      }
    : null

  return c.json({ deposit: data, sms: smsMatch, client })
})

depositRoutes.post('/:txId/decision', requirePerm('deposits', 'can_approve'), async (c) => {
  const txId = c.req.param('txId')
  if (!/^\d+$/.test(txId)) return c.json({ error: 'bad_tx_id' }, 400)

  const body = await c.req.json().catch(() => null)
  const action = body?.action as string | undefined
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  const target = action ? DECISION_TARGET[action] : undefined
  if (!target) return c.json({ error: 'bad_action' }, 400)

  const { data: before, error: readErr } = await db
    .from('maven_transactions')
    .select('tx_id, status, amount, currency, ontarget_ref, merchant, master_merchant')
    .eq('tx_id', txId)
    .maybeSingle()
  if (readErr) return c.json({ error: 'db_error', detail: readErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.status !== 'PENDING') {
    return c.json({ error: 'not_pending', status: before.status }, 409)
  }

  const actor = c.get('actor')
  const nowIso = new Date().toISOString()
  // .eq('status','PENDING') keeps the transition atomic against races.
  const { data: updated, error: updErr } = await db
    .from('maven_transactions')
    .update({
      status: target,
      approved_by: actor.username,
      last_status_change: nowIso,
      updated_at: nowIso,
    })
    .eq('tx_id', txId)
    .eq('status', 'PENDING')
    .select('tx_id, status')
  if (updErr) return c.json({ error: 'db_error', detail: updErr.message }, 500)
  if (!updated?.length) return c.json({ error: 'not_pending' }, 409)

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: `deposit.${action}`,
    entity: 'maven_transactions',
    entity_id: txId,
    before: { status: before.status },
    after: { status: target, note },
  })
  if (auditErr) {
    // The decision already landed; surface the audit failure loudly instead of hiding it.
    return c.json({ ok: true, status: target, audit_error: auditErr.message })
  }

  return c.json({ ok: true, status: target })
})
