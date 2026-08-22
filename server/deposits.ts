import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'
import { MAX_PAGE } from './paging.js'

// Deposits = maven_transactions (ground truth for the deposit flow).
// Real statuses observed in panel-v2 data: PENDING | PAID | APPROVED |
// DECLINED | EXPIRED | EXPIRED_LOCAL | UNDERPAID — never assume only three.
// created_utc/modified_utc are TEXT in two formats; first_seen_at /
// last_status_change (timestamptz) are the reliable time columns.

export const depositRoutes = new Hono<AuthEnv>()

depositRoutes.use('*', requireAuth)

// agent_name/email are only populated on part of the rows (agent_name ~71%,
// email <1%) — the card layout hides those lines entirely when empty rather
// than rendering a dash, so shipping them in the list payload is safe.
const LIST_COLUMNS =
  'tx_id, guid, ontarget_ref, merchant_tx_reference, status, amount, currency, sender_name, sender_number, agent_name, email, payment_method, gateway, merchant, sub_merchant, master_merchant, manual_entry, approved_by, to_account_number, receiving_wallet, proof_image_url, first_seen_at, last_status_change, created_utc'

// Attach the matched SMS (id, name, balance) to each visible row.
async function attachSms(rows: Record<string, unknown>[]): Promise<void> {
  const ids = rows.map((r) => r.tx_id as number)
  if (!ids.length) return
  const { data: matches } = await db.from('sms_maven_matches').select('tx_id, sms_id, receiving_wallet').in('tx_id', ids)
  if (!matches?.length) return
  const { data: smsRows } = await db
    .from('inbound_sms')
    .select('id, sender_name, amount, balance_after, received_at, receiver_number')
    .in('id', matches.map((m) => m.sms_id))
  const smsById = new Map((smsRows ?? []).map((s) => [s.id, s]))
  const byTx = new Map(matches.map((m) => [m.tx_id, smsById.get(m.sms_id)]))
  const walletByTx = new Map(matches.map((m) => [m.tx_id, m.receiving_wallet]))
  for (const r of rows) {
    const sms = byTx.get(r.tx_id as number)
    if (sms) {
      r.sms = sms
      // The SMS receiver is the proof of where the money actually landed.
      // Keep to_account_number as the allocated target, but show the actual
      // receiving wallet whenever the two differ.
      const actualWallet = walletByTx.get(r.tx_id as number) ?? sms.receiver_number
      if (actualWallet) r.receiving_wallet = actualWallet
    }
  }
}

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

  const [total, pendingAll, pending, pendingStale, paidDay, declinedDay, paidWeek, recent] = await Promise.all([
    countByStatus(),
    countByStatus('PENDING'),
    db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }).eq('status', 'PENDING').gte('first_seen_at', day).then(({ count }) => count ?? 0),
    db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }).eq('status', 'PENDING').lt('first_seen_at', day).then(({ count }) => count ?? 0),
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
    pendingAll,
    pendingStale,
    day: { paid: paidDay, declined: declinedDay },
    week: { paid: paidWeek },
    recent,
  })
})

depositRoutes.get('/', requirePerm('deposits', 'can_view'), async (c) => {
  const status = c.req.query('status')?.toUpperCase()
  const master = c.req.query('master')?.trim()
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, MAX_PAGE)
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
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  await attachSms(rows)
  return c.json({ rows, total: count ?? 0, limit, offset })
})

// Detail by OUR reference (the user-facing identifier — unique, verified).
// Registered before /:txId so the literal segment wins.
depositRoutes.get('/by-ref/:ref', requirePerm('deposits', 'can_view'), async (c) => {
  const ref = c.req.param('ref')
  if (!/^[\w-]{3,40}$/.test(ref)) return c.json({ error: 'bad_ref' }, 400)
  const { data, error } = await db
    .from('maven_transactions')
    .select('tx_id')
    .eq('ontarget_ref', ref)
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return depositDetail(c, String(data.tx_id))
})

depositRoutes.get('/:txId', requirePerm('deposits', 'can_view'), async (c) => {
  const txId = c.req.param('txId')
  if (!/^\d+$/.test(txId)) return c.json({ error: 'bad_tx_id' }, 400)
  return depositDetail(c, txId)
})

// Shared detail builder: full row (incl. raw jsonb) + matched SMS + client history.
// Data access is server-side behind the panel's own auth/RBAC (httpOnly JWT
// cookies + role_page_permissions) — the browser never holds a Supabase key,
// which is this codebase's deliberate alternative to client-side RLS.
async function depositDetail(c: Context<AuthEnv>, txId: string) {
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
}

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
    .select('tx_id, status, amount, currency, ontarget_ref, merchant, master_merchant, gateway')
    .eq('tx_id', txId)
    .maybeSingle()
  if (readErr) return c.json({ error: 'db_error', detail: readErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.status !== 'PENDING') {
    return c.json({ error: 'not_pending', status: before.status }, 409)
  }

  const actor = c.get('actor')

  // NGPay deposits execute FOR REAL through the panel-v2 ngpay-approve worker
  // (2026-08-08 decision: own worker, not the old project's browser_jobs
  // pipeline). The worker owns the decision log + row update; the old DB
  // catches up from the provider via its collector, so we deliberately skip
  // dashboard_manual_action here to avoid double execution.
  if (before.gateway === 'NagupayP2P') {
    const baseUrl = process.env.SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SECRET_KEY
    if (!baseUrl || !serviceKey) return c.json({ error: 'worker_not_configured' }, 500)
    const workerResponse = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ tx_id: Number(txId), decision: target, actor_name: actor.username, remark: note ?? undefined }),
    })
    const workerResult = await workerResponse.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
    const executed = workerResponse.ok && workerResult.executed_on_provider === true
    const { error: auditErr2 } = await db.from('audit_log').insert({
      actor_type: 'manual_panel',
      actor_id: actor.sub,
      actor_name: actor.username,
      action: `deposit.${action}`,
      entity: 'maven_transactions',
      entity_id: txId,
      before: { status: before.status },
      after: { status: target, note, provider_execution: 'ngpay-approve', executed_on_provider: executed, worker: workerResponse.ok ? undefined : workerResult },
    })
    if (!workerResponse.ok) {
      return c.json({ error: 'worker_failed', worker: workerResult }, workerResponse.status as 400 | 401 | 404 | 409 | 500)
    }
    return c.json({ ok: true, status: target, executed_on_provider: executed, audit_error: auditErr2?.message })
  }
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

  // Propagate to the OLD prod DB — the automation/workers act there, and the
  // control-room RPC also notifies Maven. Without this the decision is local-only.
  let oldSync: string = 'skipped'
  const old = oldDb()
  if (old) {
    const { error: oldErr } = await old.rpc('dashboard_manual_action', {
      p_tx_id: Number(txId),
      p_action: action,
      p_by: actor.username,
    })
    oldSync = oldErr ? `error: ${oldErr.message}` : 'ok'
  }

  // Decision log feeds the Review screen. executed_on_provider stays false at
  // record time: even when old_sync=ok the browser worker executes async, so
  // claiming provider execution here would be dishonest.
  const { error: logErr } = await db.from('deposit_decision_log').insert({
    tx_id: Number(txId),
    ontarget_ref: before.ontarget_ref,
    decision: target,
    actor_name: actor.username,
    reason: note ?? `old_sync=${oldSync}`,
    db_status_before: before.status,
    executed_on_provider: false,
  })
  if (logErr) console.error('deposit_decision_log insert failed:', logErr.message)

  const { error: auditErr } = await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: `deposit.${action}`,
    entity: 'maven_transactions',
    entity_id: txId,
    before: { status: before.status },
    after: { status: target, note, old_sync: oldSync },
  })
  if (auditErr) {
    // The decision already landed; surface the audit failure loudly instead of hiding it.
    return c.json({ ok: true, status: target, old_sync: oldSync, audit_error: auditErr.message })
  }

  return c.json({ ok: true, status: target, old_sync: oldSync })
})
