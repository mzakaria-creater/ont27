import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth } from './rbac.js'
import { applyEdit } from './txEdit.js'
import type { AuthEnv } from './rbac.js'

// Complaints are V2 operational records. Maven transactions, inbound SMS,
// tickets, Telegram delivery and the audit trail all live in the same project.
export const complaintRoutes = new Hono<AuthEnv>()
complaintRoutes.use('*', requireAuth)
const ALLOWED = new Set(['owner', 'admin', 'super_admin', 'operator', 'operations_admin'])
complaintRoutes.use('*', async (c, next) => { if (!ALLOWED.has(c.get('actor').role)) return c.json({ error: 'forbidden' }, 403); await next() })

type TxRow = Record<string, any>
type SmsRow = Record<string, any>
const esc = (v: unknown) => String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const normalizedPhone = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
const complaintPriority = (note: string | null, tx: TxRow | null) => /urgent|asap|critical|failed|emergency|fraud|aml/i.test(note ?? '') ? 'high' : tx && ['DECLINED', 'FAILED'].includes(String(tx.status ?? '').toUpperCase()) ? 'high' : tx ? 'medium' : 'normal'
const audit = (actor: { sub: string; username: string }, action: string, entityId: string, after: Record<string, unknown>, before?: Record<string, unknown>) => db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action, entity: 'complaints', entity_id: entityId, before, after })

async function notifySupport(alertType: string, message: string) {
  const { data: chats } = await db.from('telegram_chats').select('chat_id').eq('is_active', true).eq('receives_complaints', true)
  const chatIds = (chats ?? []).map((row) => String(row.chat_id))
  if (!chatIds.length) return { sent: 0, error: 'no_complaint_chats' }
  const baseUrl = process.env.SUPABASE_URL; const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return { sent: 0, error: 'telegram_not_configured' }
  try {
    const response = await fetch(`${baseUrl}/functions/v1/telegram-notify`, { method: 'POST', signal: AbortSignal.timeout(35_000), headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' }, body: JSON.stringify({ alert_type: alertType, message, chat_ids: chatIds }) })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) return { sent: 0, error: String(result.error ?? `HTTP ${response.status}`) }
    return { sent: Number(result.sent ?? 0), ...(Number(result.sent ?? 0) === 0 ? { error: String(result.error ?? 'no_complaint_chats') } : {}) }
  } catch (error) { return { sent: 0, error: error instanceof Error ? error.message : 'send_failed' } }
}

async function notifyRichComplaint(txId: number, filedBy: string, note: string | null) {
  const baseUrl = process.env.SUPABASE_URL; const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return { sent: 0, error: 'telegram_not_configured' }
  try {
    const response = await fetch(`${baseUrl}/functions/v1/complaint-notify`, { method: 'POST', signal: AbortSignal.timeout(35_000), headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' }, body: JSON.stringify({ tx_id: txId, filed_by: filedBy, note }) })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) return { sent: 0, error: String(result.error ?? `HTTP ${response.status}`) }
    return { sent: Number(result.sent ?? 0), proof_included: result.proof_included === true, ...(Number(result.sent ?? 0) === 0 ? { error: String(result.error ?? 'no_complaint_chats') } : {}) }
  } catch (error) { return { sent: 0, error: error instanceof Error ? error.message : 'send_failed' } }
}

async function loadTransaction(txId: number): Promise<TxRow | null> {
  const { data, error } = await db.from('maven_transactions').select('tx_id, ontarget_ref, status, amount, currency, gateway, merchant, master_merchant, sender_name, sender_number, receiving_wallet, to_account_number, raw, maven_raw_row, created_utc, first_seen_at, last_seen_at, approved_by, settlement_blocked').eq('tx_id', txId).maybeSingle()
  if (error) throw new Error(error.message)
  return data as TxRow | null
}

async function findSmsCandidates(tx: TxRow | null, phone: string | null, amount: number | null): Promise<SmsRow[]> {
  const targetTime = tx ? new Date(String(tx.created_utc ?? tx.first_seen_at ?? tx.last_seen_at ?? '')).getTime() : Date.now()
  const from = Number.isFinite(targetTime) ? new Date(targetTime - 90 * 60_000).toISOString() : new Date(Date.now() - 90 * 60_000).toISOString()
  const to = Number.isFinite(targetTime) ? new Date(targetTime + 90 * 60_000).toISOString() : new Date().toISOString()
  let query = db.from('inbound_sms').select('id, received_at, amount, sender_name, sender_number, receiver_number, wallet_number, confirmed_wallet_number, balance_after, sms_category, matched, match_status, consumed_by_tx_id, matched_transaction_id, sms_first_line, raw_sms, device_name, sim_slot, is_blocked, is_duplicate').gte('received_at', from).lte('received_at', to).order('received_at', { ascending: false }).limit(200)
  if (amount != null && Number.isFinite(amount)) query = query.eq('amount', amount)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const phoneKey = normalizedPhone(phone ?? tx?.sender_number); const wallet = String(tx?.receiving_wallet ?? tx?.to_account_number ?? '')
  return (data ?? []).filter((row) => {
    if (row.is_blocked || row.is_duplicate) return false
    if (row.consumed_by_tx_id != null && Number(row.consumed_by_tx_id) !== Number(tx?.tx_id)) return false
    const senderKey = normalizedPhone(row.sender_number)
    const phoneMatch = !phoneKey || !senderKey || senderKey === phoneKey
    const walletMatch = !wallet || [row.receiver_number, row.wallet_number, row.confirmed_wallet_number].filter(Boolean).includes(wallet)
    return phoneMatch && walletMatch
  }) as SmsRow[]
}

async function investigate(txId: number | null, phone: string | null, amount: number | null) {
  let tx: TxRow | null = txId ? await loadTransaction(txId) : null
  if (!tx && phone && amount != null) {
    const { data } = await db.from('maven_transactions').select('tx_id').eq('amount', amount).order('first_seen_at', { ascending: false }).limit(100)
    for (const candidate of data ?? []) { const possible = await loadTransaction(Number(candidate.tx_id)); if (possible && normalizedPhone(possible.sender_number) === normalizedPhone(phone)) { tx = possible; break } }
  }
  const sms = await findSmsCandidates(tx, phone, amount ?? (tx ? Number(tx.amount) : null))
  return { transaction: tx, sms, sms_received: sms.length > 0, balance_after: sms.find((row) => row.balance_after != null)?.balance_after ?? null, finding: sms.length ? `${sms.length} SMS candidate(s) within ±90 minutes` : 'No matching SMS found within ±90 minutes' }
}

complaintRoutes.get('/', async (c) => {
  const requestedStatus = c.req.query('status')?.trim().toLowerCase(); const txIdRaw = c.req.query('tx_id')?.trim(); const txId = txIdRaw && /^\d+$/.test(txIdRaw) ? Number(txIdRaw) : null
  if (txIdRaw && txId == null) return c.json({ error: 'invalid_tx_id' }, 400)
  const limit = Math.min(Number(c.req.query('limit')) || 100, 200)
  let query = db.from('complaints').select('*', { count: 'exact' }).order('created_at', { ascending: false }).limit(limit)
  if (txId != null) query = query.eq('tx_id', txId)
  if (requestedStatus === 'open') query = query.eq('state', 'open'); else if (requestedStatus === 'closed') query = query.eq('state', 'closed'); else if (requestedStatus && ['approved', 'declined', 'resolved'].includes(requestedStatus)) query = query.eq('status', requestedStatus)
  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const rows = (data ?? []) as TxRow[]; const ids = [...new Set(rows.map((row) => Number(row.tx_id)).filter(Number.isFinite))]
  const { data: txRows } = ids.length ? await db.from('maven_transactions').select('tx_id, status, gateway, receiving_wallet, to_account_number, sender_name, sender_number, merchant, master_merchant').in('tx_id', ids) : { data: [] as TxRow[] }
  const byId = new Map((txRows ?? []).map((row) => [Number(row.tx_id), row]))
  return c.json({ rows: rows.map((row) => ({ ...row, tx_status: row.tx_id == null ? null : byId.get(Number(row.tx_id))?.status ?? null, tx_gateway: row.tx_id == null ? null : byId.get(Number(row.tx_id))?.gateway ?? null, receiving_wallet: row.tx_id == null ? null : byId.get(Number(row.tx_id))?.receiving_wallet ?? byId.get(Number(row.tx_id))?.to_account_number ?? null })), total: count ?? 0 })
})

complaintRoutes.get('/telegram', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 100, 200)
  const { data, error } = await db.from('telegram_alerts').select('id, alert_type, chat_id, message, ok, error, created_at').in('alert_type', ['complaint_filed', 'complaint_resolved']).order('created_at', { ascending: false }).limit(limit)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ alerts: data ?? [] })
})

complaintRoutes.post('/log', async (c) => {
  const actor = c.get('actor'); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const txId = body?.tx_id == null || body.tx_id === '' ? null : Number(body.tx_id); const phone = typeof body?.phone === 'string' ? body.phone.trim().slice(0, 40) : null; const amount = body?.amount == null || body.amount === '' ? null : Number(body.amount); const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 2000) : null
  if ((txId != null && !Number.isInteger(txId)) || (amount != null && (!Number.isFinite(amount) || amount < 0)) || (!txId && !phone)) return c.json({ error: 'bad_request' }, 400)
  const tx = txId ? await loadTransaction(txId) : null
  if (txId && !tx) return c.json({ error: 'transaction_not_found' }, 404)
  if (txId) {
    const { data: existing } = await db.from('complaints').select('id, ticket_id, status, state, resolved_action, resolved_by, resolved_at').eq('tx_id', txId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (existing) return c.json({ ok: true, duplicate: true, already_decided: existing.state === 'closed', complaint: existing })
  }
  const analysis = await investigate(txId, phone, amount); const effectiveTx = tx ?? analysis.transaction; const now = new Date().toISOString()
  const row = { tx_id: effectiveTx?.tx_id ?? txId, merchant: effectiveTx?.merchant ?? effectiveTx?.master_merchant ?? null, merchant_ref: effectiveTx?.ontarget_ref ?? (String((effectiveTx?.raw as Record<string, unknown> | null)?.Reference1 ?? '') || null), amount: amount ?? effectiveTx?.amount ?? null, sender_number: phone ?? effectiveTx?.sender_number ?? null, customer_phone: phone ?? effectiveTx?.sender_number ?? null, customer_name: effectiveTx?.sender_name ?? null, filed_by: actor.username, filed_at: now, note, status: 'open', state: 'open', priority: complaintPriority(note, effectiveTx), sms_received: analysis.sms_received, sms_id: analysis.sms[0]?.id ?? null, balance_after: analysis.balance_after, finding: analysis.finding }
  const { data: complaint, error } = await db.from('complaints').insert(row).select().single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const ticketPayload = { ticket_no: `TKT-${String(complaint.id).padStart(4, '0')}`, complaint_id: complaint.id, tx_id: row.tx_id, customer_name: row.customer_name, customer_phone: row.customer_phone, amount: row.amount, subject: row.tx_id ? `Transaction complaint #${row.tx_id}` : 'Customer complaint', description: note, message_body: note, priority: row.priority, opened_by: actor.username, ticket_status: 'open', updated_by: actor.username, created_at: now, updated_at: now }
  const { data: ticket } = await db.from('support_tickets').insert(ticketPayload).select('id, ticket_no, ticket_status, priority').maybeSingle(); if (ticket) await db.from('complaints').update({ ticket_id: ticket.id }).eq('id', complaint.id)
  await audit(actor, 'complaint.created', String(complaint.id), { complaint_id: complaint.id, tx_id: row.tx_id, ticket_id: ticket?.id ?? null, priority: row.priority, sms_received: row.sms_received })
  const telegram = row.tx_id ? await notifyRichComplaint(Number(row.tx_id), actor.username, note) : await notifySupport('complaint_filed', [`📣 <b>شكوى جديدة</b>`, phone ? `هاتف العميل: <code>${esc(phone)}</code>` : null, amount != null ? `المبلغ: <b>${esc(amount)}</b>` : null, note ? `التفاصيل: ${esc(note)}` : null, `سُجِّلت بواسطة: ${esc(actor.username)}`].filter(Boolean).join('\n'))
  return c.json({ ok: true, complaint, ticket, analysis, telegram }, 201)
})

complaintRoutes.post('/investigate', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const txId = body?.tx_id == null || body.tx_id === '' ? null : Number(body.tx_id); const phone = typeof body?.phone === 'string' ? body.phone.trim() : null; const amount = body?.amount == null || body.amount === '' ? null : Number(body.amount)
  if ((txId != null && !Number.isInteger(txId)) || (!txId && !(phone && amount != null))) return c.json({ error: 'bad_request' }, 400)
  try { return c.json({ ok: true, result: await investigate(txId, phone, amount) }) } catch (error) { return c.json({ error: 'investigation_failed', detail: error instanceof Error ? error.message : 'investigation_failed' }, 500) }
})

complaintRoutes.post('/re-examine', async (c) => {
  const actor = c.get('actor')
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  const txId = Number(body?.tx_id)
  if (!Number.isInteger(txId)) return c.json({ error: 'bad_tx_id' }, 400)
  const tx = await loadTransaction(txId)
  if (!tx) return c.json({ error: 'transaction_not_found' }, 404)
  const reference = String(tx.ontarget_ref ?? txId)
  const { data: verdict, error } = await db.rpc('ontarget_tx_verdict', { p_ref: reference })
  if (error) return c.json({ error: 'verdict_failed', detail: error.message }, 500)
  const analysis = await investigate(txId, null, null)
  await db.from('complaints').update({ sms_received: analysis.sms_received, sms_id: analysis.sms[0]?.id ?? null, balance_after: analysis.balance_after, finding: analysis.finding, updated_at: new Date().toISOString() }).eq('tx_id', txId).eq('state', 'open')
  await audit(actor, 'complaint.re_examine', String(txId), { tx_id: txId, reference, sms_received: analysis.sms_received })
  return c.json({ ok: true, tx_id: txId, verdict, analysis })
})

complaintRoutes.post('/batch-investigate', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const references = Array.isArray(body?.references) ? [...new Set(body.references.map((value) => String(value).trim()).filter(Boolean))].slice(0, 50) : []
  if (!references.length) return c.json({ error: 'no_references' }, 400)
  const results = []; for (const reference of references) { const { data: tx } = await db.from('maven_transactions').select('tx_id').or(`merchant_tx_reference.eq.${reference},ontarget_ref.eq.${reference}`).maybeSingle(); results.push({ txId: reference, result: tx ? await investigate(Number(tx.tx_id), null, null) : null, error: tx ? undefined : 'transaction_not_found' }) }
  return c.json({ rows: results, generatedAt: new Date().toISOString() })
})

complaintRoutes.post('/investigation-action', async (c) => {
  const actor = c.get('actor'); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const txId = Number(body?.tx_id); const smsId = body?.sms_id == null ? null : Number(body.sms_id); const action = String(body?.action ?? ''); const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : null
  if (!Number.isInteger(txId) || !['approve_paid', 'link_sms', 'reject_complaint'].includes(action)) return c.json({ error: 'bad_request' }, 400)
  const tx = await loadTransaction(txId); if (!tx) return c.json({ error: 'transaction_not_found' }, 404)
  if (action === 'link_sms') {
    if (!Number.isInteger(smsId)) return c.json({ error: 'sms_required' }, 400); const analysis = await investigate(txId, null, null); const sms = analysis.sms.find((row) => Number(row.id) === smsId); if (!sms) return c.json({ error: 'sms_match_rules_failed' }, 409); if (sms.consumed_by_tx_id != null && Number(sms.consumed_by_tx_id) !== txId) return c.json({ error: 'sms_already_consumed' }, 409)
    const { error } = await db.from('inbound_sms').update({ consumed_by_tx_id: txId, matched_transaction_id: txId, matched: true, match_status: 'manual', review_required: false, processed_at: new Date().toISOString() }).eq('id', smsId).is('consumed_by_tx_id', null); if (error) return c.json({ error: 'link_failed', detail: error.message }, 500)
    await db.from('complaints').update({ sms_received: true, sms_id: smsId, balance_after: sms.balance_after, finding: 'SMS manually linked' }).eq('tx_id', txId).eq('state', 'open')
  } else if (action === 'approve_paid') {
    const result = await applyEdit(tx, { status: 'PAID', amount: null, reason: note || 'Approved from complaint investigation', receiving_wallet: null, sender_name: null, sender_number: null, user_email: null, sender_account_name: null }, actor.username, actor.sub, 'complaint'); if (!result.ok) return c.json({ error: result.error, detail: result.detail }, 502)
  } else if (action === 'reject_complaint') {
    const now = new Date().toISOString()
    await db.from('complaints').update({ status: 'declined', state: 'closed', verdict: 'declined', resolved_action: 'REJECTED', resolved_by: actor.username, resolved_at: now, decided_by: actor.username, decided_at: now, decision_note: note, updated_at: now }).eq('tx_id', txId).eq('state', 'open')
  }
  await audit(actor, `complaint.investigation.${action}`, String(txId), { tx_id: txId, sms_id: smsId, note, previous_status: tx.status }); return c.json({ ok: true, tx_id: txId, action, recorded_at: new Date().toISOString() })
})

const DECISIONS = new Set(['approve', 'decline', 'close'])
complaintRoutes.post('/:id/:decision', async (c) => {
  const actor = c.get('actor'); const id = Number(c.req.param('id')); const decision = c.req.param('decision'); if (!Number.isInteger(id) || !DECISIONS.has(decision)) return c.json({ error: 'bad_request' }, 400)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : null; const { data: complaint, error: complaintError } = await db.from('complaints').select('*').eq('id', id).maybeSingle()
  if (complaintError) return c.json({ error: 'db_error', detail: complaintError.message }, 500); if (!complaint) return c.json({ error: 'not_found' }, 404); if (complaint.state === 'closed') return c.json({ error: 'already_decided', status: complaint.status, decided_by: complaint.resolved_by ?? complaint.decided_by, decided_at: complaint.resolved_at ?? complaint.decided_at }, 409)
  const txId = Number(complaint.tx_id ?? body?.tx_id); if ((decision === 'approve' || decision === 'decline') && !Number.isInteger(txId)) return c.json({ error: 'bad_tx_id' }, 400)
  let providerResult: unknown = null
  if (decision === 'approve') { const tx = await loadTransaction(txId); if (!tx) return c.json({ error: 'transaction_not_found' }, 404); const result = await applyEdit(tx, { status: 'PAID', amount: null, reason: note || 'Complaint approved', receiving_wallet: null, sender_name: null, sender_number: null, user_email: null, sender_account_name: null }, actor.username, actor.sub, 'complaint'); if (!result.ok) return c.json({ error: result.error, detail: result.detail }, 502); providerResult = { executed_on_provider: result.executed === true, local_only: result.localOnly } }
  const now = new Date().toISOString(); const nextStatus = decision === 'approve' ? 'approved' : decision === 'decline' ? 'declined' : 'closed'; const update = { status: nextStatus, state: 'closed', verdict: nextStatus, resolved_action: decision === 'approve' ? 'APPROVED' : decision === 'decline' ? 'REJECTED' : 'CLOSED', resolved_by: actor.username, resolved_at: now, decided_by: actor.username, decided_at: now, decision_note: note, updated_at: now }
  const { data: updated, error: updateError } = await db.from('complaints').update(update).eq('id', id).eq('state', 'open').select().maybeSingle(); if (updateError) return c.json({ error: 'db_error', detail: updateError.message }, 500); if (!updated) return c.json({ error: 'already_decided' }, 409)
  if (complaint.ticket_id) await db.from('support_tickets').update({ ticket_status: decision === 'close' ? 'closed' : 'resolved', resolved_by: actor.username, resolved_at: now, updated_by: actor.username, updated_at: now, telegram_status: 'decision_recorded' }).eq('id', complaint.ticket_id)
  await audit(actor, `complaint.${decision}`, String(id), { tx_id: txId || null, decision, note, provider: providerResult }, complaint)
  const headline = decision === 'approve' ? '✅ شكوى: تمت الموافقة (المعاملة → PAID)' : decision === 'decline' ? '❌ شكوى: مرفوضة' : '📕 شكوى: مغلقة'; const telegram = await notifySupport('complaint_resolved', [`<b>${headline}</b>`, `رقم الشكوى: <code>${esc(id)}</code>${txId ? ` · المعاملة: <code>${esc(txId)}</code>` : ''}`, note ? `ملاحظة: ${esc(note)}` : null, `القرار بواسطة: ${esc(actor.username)}`].filter(Boolean).join('\n'))
  return c.json({ ok: true, complaint: updated, provider: providerResult, telegram })
})
