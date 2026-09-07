import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'
import { notifyApprovedTransaction } from './approvalEmail.js'

// Transaction edits: status and amount.
//
// Privileged admins can edit amounts directly. Operators can now edit status
// directly as well; this is deliberately limited to status so a routine
// approve/decline never becomes an amount re-pricing action.
//
// Two things about a "status edit" that the UI has to keep honest:
//
//  * For an NGPay transaction still PENDING at the provider, changing the
//    status IS the deposit decision, so it runs through ngpay-approve and
//    really executes on Maven. Writing the new status straight into our table
//    instead would manufacture exactly the undocumented divergence the
//    mismatch detector exists to catch.
//  * Any other status change, and every amount change, is a LOCAL correction.
//    The provider is not told. These are recorded with local_only: true and a
//    mandatory reason so they are never mistaken for a provider action.
//
// Amounts are never pushed to the provider from here at all. UpdateTransaction
// does take an amount, but re-pricing a transaction upstream is a materially
// different and riskier action than approving one, and nobody has asked for
// it.

export const txEditRoutes = new Hono<AuthEnv>()

txEditRoutes.use('*', requireAuth)

// "Operator admin" is stored as operations_admin in panel_users.
const DIRECT_STATUS_ROLES = new Set(['super_admin', 'owner', 'admin', 'operations_admin', 'operator_admin', 'operation_admin', 'operator'])
const AMOUNT_EDIT_ROLES = new Set(['super_admin', 'owner', 'admin'])
const EDITABLE_STATUSES = ['PENDING', 'PAID', 'DECLINED', 'EXPIRED', 'EXPIRED_LOCAL', 'UNDERPAID', 'APPROVED']
const PROVIDER_STATUSES = new Set(['PAID', 'DECLINED', 'EXPIRED', 'UNDERPAID', 'OVERPAID'])

// Mina and Eslam, by label in telegram_chats. Resolved at send time rather
// than hard-coding chat ids, so moving an account only touches that table.
const APPROVER_LABEL_PREFIXES = ['Mina', 'Eslam']

const TX_COLS = 'tx_id, ontarget_ref, status, amount, currency, gateway, master_merchant, sender_name, sender_number, receiving_wallet, to_account_number, maven_raw_row'

function isNgPayGateway(tx: Record<string, unknown>): boolean {
  const raw = tx.maven_raw_row && typeof tx.maven_raw_row === 'object' && !Array.isArray(tx.maven_raw_row)
    ? tx.maven_raw_row as Record<string, unknown> : null
  const gateway = String(tx.gateway ?? raw?.Gateway ?? raw?.gateway ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  return gateway === 'nagupayp2p' || gateway === 'nagopayp2p' || gateway.includes('nagupay') || gateway.includes('nagopay')
}

interface EditInput {
  status: string | null
  amount: number | null
  reason: string
  receiving_wallet: string | null
  sender_name: string | null
  sender_number: string | null
  user_email: string | null
  sender_account_name: string | null
}

function readEdit(body: unknown): EditInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : ''
  if (!reason) return { error: 'reason_required' }

  let status: string | null = null
  if (b.status != null && b.status !== '') {
    const s = String(b.status).toUpperCase()
    if (!EDITABLE_STATUSES.includes(s)) return { error: 'invalid_status' }
    status = s
  }

  let amount: number | null = null
  if (b.amount != null && b.amount !== '') {
    const n = Number(b.amount)
    if (!Number.isFinite(n) || n <= 0) return { error: 'invalid_amount' }
    amount = n
  }

  const textField = (key: string, max = 180) => {
    if (b[key] == null || b[key] === '') return null
    return typeof b[key] === 'string' ? b[key].trim().slice(0, max) || null : null
  }
  const receiving_wallet = textField('receiving_wallet', 40)
  const sender_name = textField('sender_name', 120)
  const sender_number = textField('sender_number', 40)
  const user_email = textField('user_email', 180)
  const sender_account_name = textField('sender_account_name', 120)
  if (status == null && amount == null && !receiving_wallet && !sender_name && !sender_number && !user_email && !sender_account_name) return { error: 'nothing_to_change' }
  return { status, amount, reason, receiving_wallet, sender_name, sender_number, user_email, sender_account_name }
}

async function loadTx(txId: number) {
  const { data } = await db.from('maven_transactions').select(TX_COLS).eq('tx_id', txId).maybeSingle()
  return data
}

export interface SentMessage { chat_id: string; message_id: number }

async function notifyApprovers(
  alertType: string,
  message: string,
  replyMarkup?: unknown,
): Promise<{ sent: number; chatIds: string[]; messages: SentMessage[]; error?: string }> {
  const { data: chats } = await db.from('telegram_chats').select('chat_id, label').eq('is_active', true)
  const chatIds = (chats ?? [])
    .filter((c) => APPROVER_LABEL_PREFIXES.some((p) => (c.label ?? '').trim().toLowerCase().startsWith(p.toLowerCase())))
    .map((c) => String(c.chat_id))
  if (!chatIds.length) return { sent: 0, chatIds: [], messages: [], error: 'no_approver_chats' }

  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return { sent: 0, chatIds, messages: [], error: 'telegram_not_configured' }
  try {
    const res = await fetch(`${baseUrl}/functions/v1/telegram-notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ alert_type: alertType, message, chat_ids: chatIds, reply_markup: replyMarkup }),
    })
    const out = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) return { sent: 0, chatIds, messages: [], error: String(out.error ?? `HTTP ${res.status}`) }
    // Only messages that actually landed carry an id, and only those can be
    // edited later to switch the buttons off.
    const messages = ((out.results ?? []) as { chat_id?: string; ok?: boolean; message_id?: number }[])
      .filter((r) => r.ok && r.chat_id && typeof r.message_id === 'number')
      .map((r) => ({ chat_id: String(r.chat_id), message_id: Number(r.message_id) }))
    return { sent: Number(out.sent ?? 0), chatIds, messages }
  } catch (e) {
    return { sent: 0, chatIds, messages: [], error: e instanceof Error ? e.message : 'send_failed' }
  }
}

// Rewrite the approval messages in place once a request is settled.
//
// A decision taken in the panel has to reach Telegram too, otherwise Mina and
// Eslam keep looking at a live pair of buttons for something already decided —
// and pressing one then returns "already decided", which reads like a bug. The
// message becomes the record of who decided and what happened.
//
// Editing needs the bot token directly (telegram-notify only sends), and this
// is best-effort: a failure here must never undo a decision that was already
// applied to the transaction.
async function settleApproverMessages(
  row: { id: number; ontarget_ref?: unknown; tx_id?: unknown; telegram_message_ids?: unknown },
  headline: string,
  detail: string,
): Promise<void> {
  const pairs = Array.isArray(row.telegram_message_ids) ? row.telegram_message_ids : []
  if (!pairs.length) return
  const { data: cfg } = await db
    .from('maven_runtime_config').select('value')
    .eq('name', 'TELEGRAM_BOT_TOKEN').eq('owner_name', 'global').maybeSingle()
  const token = cfg?.value
  if (!token) return

  const text =
    `<b>${esc(headline)}</b>\n` +
    `المرجع: <code>${esc(row.ontarget_ref ?? row.tx_id)}</code>\n` +
    `${esc(detail)}\n` +
    `رقم الطلب: <code>${row.id}</code>`

  for (const p of pairs as { chat_id?: string; message_id?: number }[]) {
    if (!p?.chat_id || !p?.message_id) continue
    try {
      await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: p.chat_id, message_id: p.message_id, text,
          parse_mode: 'HTML', reply_markup: { inline_keyboard: [] },
        }),
      })
    } catch {
      // Best effort — the decision is already recorded either way.
    }
  }
}

function esc(v: unknown): string {
  return String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Applies an approved edit. Returns the audit payload or an error string.
async function applyEdit(
  tx: Record<string, unknown>,
  edit: EditInput,
  actorName: string,
  actorId: string | undefined,
  source: string,
): Promise<{ ok: true; localOnly: boolean; executed?: boolean } | { ok: false; error: string; detail?: unknown }> {
  const txId = Number(tx.tx_id)
  const patch: Record<string, unknown> = {}
  let executed: boolean | undefined
  let localOnly = true

  // A status change that IS the deposit decision goes through the real worker.
  const currentStatus = String(tx.status ?? '').toUpperCase()
  const isProviderDecision =
    edit.status != null &&
    isNgPayGateway(tx) &&
    PROVIDER_STATUSES.has(edit.status) &&
    (currentStatus === 'PENDING' || (currentStatus === 'DECLINED' && edit.status === 'PAID'))

  if (isProviderDecision) {
    const baseUrl = process.env.SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SECRET_KEY
    if (!baseUrl || !serviceKey) return { ok: false, error: 'worker_not_configured' }
    const res = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        tx_id: txId,
        decision: edit.status,
        actor_name: actorName,
        remark: edit.reason,
        source: currentStatus === 'DECLINED' && edit.status === 'PAID' ? 'direct_edit' : 'panel_decision',
        allow_reversal: currentStatus === 'DECLINED' && edit.status === 'PAID',
      }),
    })
    const out = await res.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
    if (!res.ok || out.executed_on_provider !== true) {
      return { ok: false, error: 'worker_failed', detail: out }
    }
    executed = true
    localOnly = false
    // The worker already verified Maven. Mirror the confirmed result locally
    // now so the queue does not wait for a later provider sync repaint.
    const mirrorNow = new Date().toISOString()
    const { error: mirrorErr } = await db.from('maven_transactions').update({
      status: edit.status,
      approved_by: actorName,
      last_status_change: mirrorNow,
      updated_at: mirrorNow,
    }).eq('tx_id', txId).eq('status', 'PENDING')
    if (mirrorErr) console.error('provider edit mirror update failed', { txId, error: mirrorErr.message })
  } else if (edit.status != null) {
    patch.status = edit.status
    patch.last_status_change = new Date().toISOString()
  }

  if (edit.amount != null) patch.amount = edit.amount

  const raw = tx.maven_raw_row && typeof tx.maven_raw_row === 'object' && !Array.isArray(tx.maven_raw_row)
    ? { ...(tx.maven_raw_row as Record<string, unknown>) } : {}
  const rawBefore = { ...raw }
  if (edit.receiving_wallet != null) {
    patch.receiving_wallet = edit.receiving_wallet
    patch.to_account_number = edit.receiving_wallet
    raw.BankWalletNumber = edit.receiving_wallet
    raw.AccountNumber = edit.receiving_wallet
    raw.ToBankAccountNumber = edit.receiving_wallet
  }
  if (edit.sender_name != null) { patch.sender_name = edit.sender_name; raw.FirstName = edit.sender_name; raw.AccountName = edit.sender_name }
  if (edit.sender_number != null) { patch.sender_number = edit.sender_number; raw.PhoneNo = edit.sender_number }
  if (edit.user_email != null) raw.EmailAddress = edit.user_email
  if (edit.sender_account_name != null) { raw.SenderAccountName = edit.sender_account_name; raw.BankAccountName = edit.sender_account_name }
  const rawChanged = JSON.stringify(raw) !== JSON.stringify(rawBefore)
  if (rawChanged) patch.maven_raw_row = raw

  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString()
    const { error } = await db.from('maven_transactions').update(patch).eq('tx_id', txId)
    if (error) return { ok: false, error: 'db_error', detail: error.message }
  }

  await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actorId,
    actor_name: actorName,
    action: 'transaction.edit',
    entity: 'maven_transactions',
    entity_id: String(txId),
    before: { status: tx.status, amount: tx.amount, receiving_wallet: tx.receiving_wallet ?? tx.to_account_number, sender_name: tx.sender_name, sender_number: tx.sender_number, maven_raw_row: rawBefore },
    after: {
      status: edit.status ?? tx.status,
      amount: edit.amount ?? tx.amount,
      receiving_wallet: edit.receiving_wallet ?? tx.receiving_wallet ?? tx.to_account_number,
      sender_name: edit.sender_name ?? tx.sender_name,
      sender_number: edit.sender_number ?? tx.sender_number,
      user_email: edit.user_email,
      sender_account_name: edit.sender_account_name,
      maven_raw_row: rawChanged ? raw : undefined,
      reason: edit.reason,
      source,
      // The single most important field here: whether the provider was told.
      local_only: localOnly,
      executed_on_provider: executed ?? false,
    },
  })

  if (edit.status === 'PAID' || edit.status === 'APPROVED') {
    await notifyApprovedTransaction({ ...tx, tx_id: txId, amount: edit.amount ?? tx.amount, status: edit.status, approved_by: actorName, approved_at: new Date().toISOString(), provider_confirmed: executed === true })
  }

  return { ok: true, localOnly, executed }
}

// ---- Direct edit (admins and operators for status; admins for amount) ----
txEditRoutes.post('/:txId/edit', async (c) => {
  const actor = c.get('actor')
  if (!DIRECT_STATUS_ROLES.has(actor.role)) return c.json({ error: 'direct_edit_role_required', role: actor.role }, 403)

  const txId = Number(c.req.param('txId'))
  if (!Number.isFinite(txId)) return c.json({ error: 'invalid_tx_id' }, 400)

  const parsed = readEdit(await c.req.json().catch(() => null))
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)
  // Amount corrections are materially higher risk than a status decision.
  // Keep them restricted to the stewardship roles even when an operator can
  // edit a status directly from the complaint or transactions page.
  if (parsed.amount != null && !AMOUNT_EDIT_ROLES.has(actor.role)) {
    return c.json({ error: 'amount_edit_requires_admin' }, 403)
  }

  const tx = await loadTx(txId)
  if (!tx) return c.json({ error: 'not_found' }, 404)

  const result = await applyEdit(tx as Record<string, unknown>, parsed, actor.username, actor.sub, 'direct_edit')
  if (!result.ok) return c.json(result, result.error === 'worker_failed' ? 502 : 500)
  return c.json({ ok: true, tx_id: txId, local_only: result.localOnly, executed_on_provider: result.executed ?? false })
})

// ---- Operator raises a request ----
txEditRoutes.post('/:txId/edit-request', async (c) => {
  const actor = c.get('actor')
  const txId = Number(c.req.param('txId'))
  if (!Number.isFinite(txId)) return c.json({ error: 'invalid_tx_id' }, 400)

  const parsed = readEdit(await c.req.json().catch(() => null))
  if ('error' in parsed) return c.json({ error: parsed.error }, 400)

  const tx = await loadTx(txId)
  if (!tx) return c.json({ error: 'not_found' }, 404)

  const { data: row, error } = await db
    .from('transaction_edit_requests')
    .insert({
      tx_id: txId,
      ontarget_ref: tx.ontarget_ref,
      requested_status: parsed.status,
      requested_amount: parsed.amount,
      current_status: tx.status,
      current_amount: tx.amount,
      reason: parsed.reason,
      requested_by: actor.username,
      requested_by_role: actor.role,
    })
    .select()
    .single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)

  const lines = [
    '✏️ <b>طلب تعديل معاملة</b>',
    `المرجع: <code>${esc(tx.ontarget_ref ?? txId)}</code>`,
    `مقدّم الطلب: ${esc(actor.username)} (${esc(actor.role)})`,
  ]
  if (parsed.status) lines.push(`الحالة: <b>${esc(tx.status)}</b> ← <b>${esc(parsed.status)}</b>`)
  if (parsed.amount != null) lines.push(`المبلغ: <b>${esc(tx.amount)}</b> ← <b>${esc(parsed.amount)}</b> ${esc(tx.currency ?? '')}`)
  lines.push(`السبب: ${esc(parsed.reason)}`, '', `رقم الطلب: <code>${row.id}</code> — لا يُنفَّذ إلا بعد موافقتك، من الأزرار هنا أو من اللوحة.`)

  // The buttons carry only the request id and the verb. Everything that decides
  // what actually happens — the target status, the amount, the transaction — is
  // read from the row at press time, so a stale or copied button can never
  // smuggle in different values.
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ موافقة', callback_data: `txedit:${row.id}:approve` },
      { text: '❌ رفض', callback_data: `txedit:${row.id}:reject` },
    ]],
  }

  const notified = await notifyApprovers('transaction_edit_request', lines.join('\n'), keyboard)
  await db.from('transaction_edit_requests')
    .update({ notified_chat_ids: notified.chatIds, telegram_message_ids: notified.messages })
    .eq('id', row.id)

  await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action: 'transaction.edit_requested',
    entity: 'transaction_edit_requests',
    entity_id: String(row.id),
    after: { tx_id: txId, requested_status: parsed.status, requested_amount: parsed.amount, reason: parsed.reason, telegram_sent: notified.sent },
  })

  // The request is stored either way — but never claim it reached anyone when
  // the send failed.
  return c.json({ ok: true, request: row, telegram: { sent: notified.sent, chat_ids: notified.chatIds, error: notified.error } }, 201)
})

// ---- Request queue ----
txEditRoutes.get('/edit-requests', async (c) => {
  const status = c.req.query('status')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  let q = db.from('transaction_edit_requests').select('*').order('created_at', { ascending: false }).limit(limit)
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const rows = data ?? []
  const txIds = rows.map((r) => Number(r.tx_id)).filter(Number.isFinite)
  const txMap = new Map<number, Record<string, unknown>>()
  const smsMap = new Map<number, Record<string, unknown>>()
  if (txIds.length) {
    const [{ data: txRows }, { data: smsRows }] = await Promise.all([
      db.from('maven_transactions').select('tx_id, status, amount, currency, sender_name, sender_number, receiving_wallet, to_account_number, created_utc, modified_utc, first_seen_at, master_merchant, merchant, maven_raw_row').in('tx_id', txIds),
      db.from('inbound_sms').select('id, consumed_by_tx_id, matched_transaction_id, received_at, amount, sender_name, sender_number, receiver_number, sms_first_line, match_status, matched').or(`consumed_by_tx_id.in.(${txIds.join(',')}),matched_transaction_id.in.(${txIds.join(',')})`).order('received_at', { ascending: false }),
    ])
    for (const row of txRows ?? []) txMap.set(Number(row.tx_id), row as Record<string, unknown>)
    for (const row of smsRows ?? []) {
      const txId = Number(row.consumed_by_tx_id ?? row.matched_transaction_id)
      if (Number.isFinite(txId) && !smsMap.has(txId)) smsMap.set(txId, row as Record<string, unknown>)
    }
  }
  const normalize = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
  const phones = [...new Set([...txMap.values()].map((r) => String(r.sender_number ?? '').trim()).filter(Boolean))]
  const approved = new Map<string, number>()
  if (phones.length) {
    const { data: paid } = await db.from('maven_transactions').select('sender_number').in('sender_number', phones).in('status', ['PAID', 'APPROVED']).limit(10_000)
    for (const row of paid ?? []) { const key = normalize(row.sender_number); if (key) approved.set(key, (approved.get(key) ?? 0) + 1) }
  }
  return c.json({ rows: rows.map((request) => {
    const tx = txMap.get(Number(request.tx_id)) ?? {}
    const previous = Math.max(0, (approved.get(normalize(tx.sender_number)) ?? 0) - (String(tx.status).toUpperCase() === 'PAID' || String(tx.status).toUpperCase() === 'APPROVED' ? 1 : 0))
    return {
      ...request,
      tx_status: tx.status ?? request.current_status,
      tx_amount: tx.amount ?? request.current_amount,
      currency: tx.currency ?? 'EGP',
      created_utc: tx.created_utc ?? tx.first_seen_at ?? request.created_at,
      modified_utc: tx.modified_utc ?? null,
      sender_name: tx.sender_name ?? null,
      sender_number: tx.sender_number ?? null,
      receiving_wallet: tx.receiving_wallet ?? tx.to_account_number ?? null,
      merchant: tx.merchant ?? null,
      master_merchant: tx.master_merchant ?? null,
      deposit_kind: previous > 0 ? 'retention_deposit' : 'first_deposit',
      previous_approved_deposits: previous,
      matched_sms: smsMap.get(Number(request.tx_id)) ?? null,
    }
  }), canDecide: DIRECT_STATUS_ROLES.has(c.get('actor').role) })
})

// ---- Approve / reject a request ----
txEditRoutes.post('/edit-requests/:id/decision', async (c) => {
  const actor = c.get('actor')
  if (!DIRECT_STATUS_ROLES.has(actor.role)) return c.json({ error: 'steward_role_required', role: actor.role }, 403)

  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const approve = body?.action === 'approve'
  if (!approve && body?.action !== 'reject') return c.json({ error: 'action must be approve or reject' }, 400)
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : null

  const { data: req } = await db.from('transaction_edit_requests').select('*').eq('id', id).maybeSingle()
  if (!req) return c.json({ error: 'not_found' }, 404)
  if (req.status !== 'pending') return c.json({ error: 'already_decided', status: req.status }, 409)

  const nowIso = new Date().toISOString()
  if (!approve) {
    await db.from('transaction_edit_requests')
      .update({ status: 'rejected', decided_by: actor.username, decided_at: nowIso, decision_note: note })
      .eq('id', id)
    await db.from('audit_log').insert({
      actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
      action: 'transaction.edit_rejected', entity: 'transaction_edit_requests', entity_id: String(id),
      after: { tx_id: req.tx_id, note },
    })
    await settleApproverMessages(req, '❌ رُفض الطلب',
      `القرار بواسطة: ${actor.username}\nلم يتغيّر شيء في المعاملة.${note ? `\nملاحظة: ${note}` : ''}`)
    return c.json({ ok: true, status: 'rejected' })
  }

  const tx = await loadTx(Number(req.tx_id))
  if (!tx) return c.json({ error: 'not_found' }, 404)

  const result = await applyEdit(
    tx as Record<string, unknown>,
    { status: req.requested_status, amount: req.requested_amount, reason: req.reason, receiving_wallet: null, sender_name: null, sender_number: null, user_email: null, sender_account_name: null },
    actor.username,
    actor.sub,
    `edit_request:${id}`,
  )

  if (!result.ok) {
    await db.from('transaction_edit_requests')
      .update({ status: 'failed', decided_by: actor.username, decided_at: nowIso, decision_note: note, apply_error: JSON.stringify(result) })
      .eq('id', id)
    // Never let Telegram show a settled request that actually failed here.
    await settleApproverMessages(req, '⚠️ ووفِق عليه لكن التنفيذ فشل',
      `القرار بواسطة: ${actor.username}\nالخطأ: ${result.error}\nالمعاملة لم تتغيّر.`)
    return c.json(result, 502)
  }

  await db.from('transaction_edit_requests')
    .update({ status: 'applied', decided_by: actor.username, decided_at: nowIso, decision_note: note })
    .eq('id', id)
  await settleApproverMessages(req, '✅ ووفِق عليه ونُفِّذ',
    `القرار بواسطة: ${actor.username}\n` +
    (result.executed
      ? 'نُفِّذ على المزوّد وتم التحقق منه.'
      : 'تصحيح محلي فقط — لم يُبلَّغ المزوّد.') +
    (note ? `\nملاحظة: ${note}` : ''))
  return c.json({ ok: true, status: 'applied', local_only: result.localOnly, executed_on_provider: result.executed ?? false })
})
