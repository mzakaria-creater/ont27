import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth, requirePerm } from './rbac.js'
import { applyDepositScopes, rowAllowed } from './accessScopes.js'
import type { AuthEnv } from './rbac.js'
import { MAX_PAGE } from './paging.js'
import { learnTrustedSmsName } from './clientIdentity.js'

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
  'tx_id, guid, ontarget_ref, merchant_tx_reference, status, amount, currency, sender_name, sender_number, agent_name, email, payment_method, gateway, merchant, sub_merchant, master_merchant, manual_entry, approved_by, to_account_number, receiving_wallet, proof_image_url, first_seen_at, last_status_change, created_utc, maven_raw_row'

const APPROVED_STATUSES = new Set(['PAID', 'APPROVED'])
const phoneKey = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
const txTime = (row: Record<string, unknown>) => {
  const raw = String(row.created_utc ?? row.first_seen_at ?? '')
  const parsed = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`)
  return Number.isFinite(parsed) ? parsed : 0
}

// Adds two operator-facing facts without persisting a mutable label on every
// transaction. "Retention" means this exact client had an approved deposit
// BEFORE this transaction; it is not inferred from name, amount, or merchant.
// Provider status is labelled explicitly so operators do not confuse an
// NGPay result with a local workflow/review decision.
async function attachDepositContext(rows: Record<string, unknown>[]): Promise<void> {
  const keys = new Set(rows.map((row) => phoneKey(row.sender_number)).filter(Boolean))
  const variants = [...keys].flatMap((key) => [key, `0${key}`, `20${key}`])
  const approvedByPhone = new Map<string, { tx_id: number; at: number }[]>()

  if (variants.length) {
    const { data, error } = await db
      .from('maven_transactions')
      .select('tx_id, sender_number, status, first_seen_at, created_utc')
      .in('sender_number', variants)
      .in('status', [...APPROVED_STATUSES])
      .order('first_seen_at', { ascending: false, nullsFirst: false })
      .limit(10_000)
    if (error) throw new Error(`deposit history: ${error.message}`)
    for (const history of data ?? []) {
      const key = phoneKey(history.sender_number)
      if (!key) continue
      const list = approvedByPhone.get(key) ?? []
      list.push({ tx_id: Number(history.tx_id), at: txTime(history as Record<string, unknown>) })
      approvedByPhone.set(key, list)
    }
  }

  for (const row of rows) {
    const raw = row.maven_raw_row && typeof row.maven_raw_row === 'object' && !Array.isArray(row.maven_raw_row)
      ? row.maven_raw_row as Record<string, unknown> : null
    const rawEntries = raw ? Object.entries(raw) : []
    const accountEntry = rawEntries.find(([key]) => key.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'accountnumber')
    row.sender_account_number = accountEntry?.[1] == null ? (row.sender_number ?? null) : (String(accountEntry[1]).trim() || row.sender_number || null)
    delete row.maven_raw_row
    const key = phoneKey(row.sender_number)
    const at = txTime(row)
    const prior = key
      ? (approvedByPhone.get(key) ?? []).filter((approved) => approved.at < at || (approved.at === at && approved.tx_id < Number(row.tx_id))).length
      : 0
    row.approved_deposits_before = prior
    row.deposit_kind = prior > 0 ? 'retention' : 'first'
    row.ngpay_status = row.gateway === 'NagupayP2P' ? row.status : null
  }
}

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
      .order('first_seen_at', { ascending: false, nullsFirst: false })
      .limit(10)
      .then(({ data, error }) => {
        if (error) throw new Error(error.message)
        return data ?? []
      }),
  ])

  await attachDepositContext(recent as Record<string, unknown>[])

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
    .order('first_seen_at', { ascending: false, nullsFirst: false })
    .order('tx_id', { ascending: false })
    .range(offset, offset + limit - 1)
  query = await applyDepositScopes(query,c.get('actor'),'view')

  if (status) query = query.eq('status', status)
  if (master) query = query.ilike('master_merchant', `%${master}%`)
  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [
      `ontarget_ref.ilike.${like}`,
      `merchant_tx_reference.ilike.${like}`,
      `sender_number.ilike.${like}`,
      `sender_name.ilike.${like}`,
      `email.ilike.${like}`,
      `manual_sender_number.ilike.${like}`,
      `maven_raw_row->>AccountNumber.ilike.${like}`,
      `maven_raw_row->>PhoneNo.ilike.${like}`,
      `maven_raw_row->>UserName.ilike.${like}`,
      `merchant.ilike.${like}`,
      `guid.ilike.${like}`,
    ]
    if (/^\d+$/.test(q)) ors.push(`tx_id.eq.${q}`)
    if (/^\d+(\.\d{1,2})?$/.test(q)) ors.push(`amount.eq.${q}`)
    query = query.or(ors.join(','))
  }

  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  await Promise.all([attachSms(rows), attachDepositContext(rows)])
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
  await attachDepositContext([data as Record<string, unknown>])

  // Matched SMS + client history + every local action that can explain how
  // this row reached its current state. All sources are read server-side so
  // audit payloads and provider diagnostics never require a browser DB key.
  const [smsMatch, clientRows, auditRows, decisionRows, editRows] = await Promise.all([
    db
      .from('sms_maven_matches')
      .select('sms_id, sec_diff, matched_at')
      .eq('tx_id', txId)
      .maybeSingle()
      .then(async ({ data: m }) => {
        if (!m) return null
        const { data: sms } = await db
          .from('inbound_sms')
          .select('id, received_at, device_name, sim_slot, sender_name, sender_number, receiver_number, amount, balance_after, sms_category, trx_id, provider, webhook_name, sms_first_line, raw_sms, match_status, matched, risk_score, risk_reason, suspicious, is_duplicate')
          .eq('id', m.sms_id)
          .maybeSingle()
        return sms ? { ...sms, sec_diff: m.sec_diff, matched_at: m.matched_at } : null
      }),
    data.sender_number
      ? db
          .from('maven_transactions')
          .select('tx_id, status, amount, first_seen_at, created_utc')
          .eq('sender_number', data.sender_number)
          .limit(1_000)
          .then(({ data: rows }) => rows ?? [])
      : Promise.resolve([]),
    db.from('audit_log')
      .select('id, actor_type, actor_name, action, before, after, created_at')
      .eq('entity', 'maven_transactions').eq('entity_id', txId)
      .order('created_at', { ascending: false }).limit(100)
      .then(({ data: rows }) => rows ?? []),
    db.from('deposit_decision_log')
      .select('id, decision, actor_name, reason, db_status_before, provider_raw_status_at_decision, executed_on_provider, created_at')
      .eq('tx_id', txId).order('created_at', { ascending: false }).limit(100)
      .then(({ data: rows }) => rows ?? []),
    db.from('transaction_edit_requests')
      .select('id, requested_status, requested_amount, current_status, current_amount, reason, requested_by, requested_by_role, status, decided_by, decided_at, decision_note, apply_error, created_at')
      .eq('tx_id', txId).order('created_at', { ascending: false }).limit(100)
      .then(({ data: rows }) => rows ?? []),
  ])

  // The execution engine and provider event stream still live on the source
  // project. These are diagnostics only; a source outage must not make the
  // transaction detail page unavailable.
  const source = oldDb()
  const [reviewRows, jobRows, providerRows] = source ? await Promise.all([
    source.from('review_queue')
      .select('id, decision, decision_reason, target_status, matched_sms_id, match_score, match_reasons, assigned_tier, assigned_reviewer, decided_by, decided_at, action_source, created_at, updated_at')
      .eq('tx_id', txId).order('updated_at', { ascending: false }).limit(20)
      .then(({ data: rows }) => rows ?? []),
    source.from('browser_jobs')
      .select('id, target_status, source, state, last_error, attempts, max_attempts, maven_before_status, maven_after_status, dispatch_mode, operator_username, created_at, updated_at, completed_at, failed_at')
      .eq('tx_id', txId).order('created_at', { ascending: false }).limit(20)
      .then(({ data: rows }) => rows ?? []),
    source.from('ngpay_approval_events')
      .select('id, status, approved_by, assigned_to_name, note, source, maven_target, maven_synced, created_at, updated_at')
      .eq('tx_id', txId).order('created_at', { ascending: false }).limit(20)
      .then(({ data: rows }) => rows ?? []),
  ]) : [[], [], []]

  const client = data.sender_number
    ? {
        total: clientRows.length,
        paid: clientRows.filter((r) => r.status === 'PAID' || r.status === 'APPROVED').length,
        declined: clientRows.filter((r) => r.status === 'DECLINED').length,
        pending: clientRows.filter((r) => r.status === 'PENDING').length,
        approved_total: clientRows.filter((r) => r.status === 'PAID' || r.status === 'APPROVED').reduce((sum, r) => sum + Number(r.amount ?? 0), 0),
        first_seen_at: clientRows.map((r) => r.first_seen_at).filter(Boolean).sort()[0] ?? null,
        last_seen_at: clientRows.map((r) => r.first_seen_at).filter(Boolean).sort().at(-1) ?? null,
      }
    : null

  const history = [
    ...auditRows.map((row) => ({ id: `audit:${row.id}`, type: 'audit', title: row.action, actor: row.actor_name ?? row.actor_type, at: row.created_at, before: row.before, after: row.after })),
    ...decisionRows.map((row) => ({ id: `decision:${row.id}`, type: 'decision', title: row.decision, detail: row.reason, actor: row.actor_name, at: row.created_at, before: { status: row.db_status_before, provider_status: row.provider_raw_status_at_decision }, after: { executed_on_provider: row.executed_on_provider } })),
    ...editRows.flatMap((row) => [
      { id: `edit-request:${row.id}`, type: 'edit_request', title: 'transaction.edit_requested', detail: row.reason, actor: row.requested_by, at: row.created_at, before: { status: row.current_status, amount: row.current_amount }, after: { status: row.requested_status, amount: row.requested_amount, request_status: row.status } },
      ...(row.decided_at ? [{ id: `edit-decision:${row.id}`, type: 'edit_decision', title: `transaction.edit_${row.status}`, detail: row.decision_note ?? row.apply_error, actor: row.decided_by, at: row.decided_at, after: { request_status: row.status } }] : []),
    ]),
    ...reviewRows.map((row) => ({ id: `review:${row.id}`, type: 'automation', title: row.decision, detail: row.decision_reason, actor: row.decided_by ?? 'automation', at: row.updated_at ?? row.created_at, after: { target_status: row.target_status, match_score: row.match_score, matched_sms_id: row.matched_sms_id, match_reasons: row.match_reasons } })),
    ...jobRows.map((row) => ({ id: `job:${row.id}`, type: 'provider_job', title: `provider_job.${row.state}`, detail: row.last_error, actor: row.operator_username ?? row.source, at: row.completed_at ?? row.failed_at ?? row.updated_at ?? row.created_at, before: { status: row.maven_before_status }, after: { status: row.maven_after_status, target_status: row.target_status, attempts: row.attempts, dispatch_mode: row.dispatch_mode } })),
    ...providerRows.map((row) => ({ id: `provider:${row.id}`, type: 'provider', title: `ngpay.${row.status}`, detail: row.note, actor: row.approved_by ?? row.assigned_to_name ?? row.source, at: row.updated_at ?? row.created_at, after: { maven_target: row.maven_target, maven_synced: row.maven_synced } })),
  ].sort((a, b) => Date.parse(String(b.at ?? '')) - Date.parse(String(a.at ?? '')))

  const raw = data.maven_raw_row && typeof data.maven_raw_row === 'object' ? data.maven_raw_row : null
  return c.json({
    deposit: { ...data, raw }, sms: smsMatch, client, history,
    provider: { review: reviewRows[0] ?? null, jobs: jobRows, events: providerRows },
  })
}

depositRoutes.post('/:txId/decision', requirePerm('deposits', 'can_approve'), async (c) => {
  const requestStartedAt = performance.now()
  const txId = c.req.param('txId')
  if (!/^\d+$/.test(txId)) return c.json({ error: 'bad_tx_id' }, 400)

  const body = await c.req.json().catch(() => null)
  const action = body?.action as string | undefined
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  const target = action ? DECISION_TARGET[action] : undefined
  if (!target) return c.json({ error: 'bad_action' }, 400)

  const { data: before, error: readErr } = await db
    .from('maven_transactions')
    .select('tx_id, status, amount, currency, ontarget_ref, merchant, master_merchant, gateway, country, payment_method, request_type')
    .eq('tx_id', txId)
    .maybeSingle()
  if (readErr) return c.json({ error: 'db_error', detail: readErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (!await rowAllowed(c.get('actor'),before,'approve')) return c.json({error:'outside_assigned_scope'},403)
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
    const workerStartedAt = performance.now()
    const workerResponse = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ tx_id: Number(txId), decision: target, actor_name: actor.username, remark: note ?? undefined }),
    })
    const workerResult = await workerResponse.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
    const executed = workerResponse.ok && workerResult.executed_on_provider === true
    const workerMs = Math.round(performance.now() - workerStartedAt)
    if (!workerResponse.ok) {
      // Failure auditing remains in the response path so a failed provider
      // attempt can never disappear from the operational record.
      await db.from('audit_log').insert({
        actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
        action: `deposit.${action}`, entity: 'maven_transactions', entity_id: txId,
        before: { status: before.status },
        after: { status: target, note, provider_execution: 'ngpay-approve', executed_on_provider: false, worker: workerResult, worker_ms: workerMs },
      })
      return c.json({ error: 'worker_failed', worker: workerResult }, workerResponse.status as 400 | 401 | 404 | 409 | 500)
    }

    // The worker has now verified the live provider result. Audit mirroring and
    // CRM identity learning are important, but neither may delay the operator's
    // confirmed response. Vercel's execution context keeps this promise alive.
    const postProcessing = (async () => {
      const { error: auditErr } = await db.from('audit_log').insert({
        actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
        action: `deposit.${action}`, entity: 'maven_transactions', entity_id: txId,
        before: { status: before.status },
        after: { status: target, note, provider_execution: 'ngpay-approve', executed_on_provider: executed, worker_ms: workerMs },
      })
      if (auditErr) console.error('deposit decision audit mirror failed', { txId, error: auditErr.message })
      if (action !== 'approve' || !executed) return
      const learnedIdentity = await learnTrustedSmsName(Number(txId))
      if (learnedIdentity.learned) await db.from('audit_log').insert({
        actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
        action: 'crm.sms_name_learned', entity: 'maven_transactions', entity_id: txId,
        after: { purpose: 'retention_matching' },
      })
    })()
    postProcessing.catch((error) => console.error('deposit decision post-processing failed', { txId, error }))
    try { c.executionCtx.waitUntil(postProcessing) } catch { /* Node/Railway keeps active promises alive itself. */ }

    const totalMs = Math.round(performance.now() - requestStartedAt)
    console.info('deposit decision executed', { txId, action, actor: actor.username, worker_ms: workerMs, total_ms: totalMs })
    c.header('Server-Timing', `provider;dur=${workerMs}, total;dur=${totalMs}`)
    return c.json({ ok: true, status: target, executed_on_provider: executed, post_processing: 'scheduled', timings_ms: { provider: workerMs, total: totalMs } })
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

  const learnedIdentity = action === 'approve'
    ? await learnTrustedSmsName(Number(txId))
    : { learned: false, reason: 'not_an_approval' }
  if (learnedIdentity.learned) await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'crm.sms_name_learned', entity: 'maven_transactions', entity_id: txId,
    after: { purpose: 'retention_matching' },
  })
  return c.json({ ok: true, status: target, old_sync: oldSync, learned_sms_name: learnedIdentity })
})
