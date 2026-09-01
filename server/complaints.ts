import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// الشكاوى — tx_complaints + complaint_* RPCs live on the OLD prod DB.

export const complaintRoutes = new Hono<AuthEnv>()

complaintRoutes.use('*', requireAuth)

const ALLOWED = new Set(['owner', 'admin', 'super_admin', 'operator', 'operations_admin'])
complaintRoutes.use('*', async (c, next) => {
  if (!ALLOWED.has(c.get('actor').role)) return c.json({ error: 'forbidden' }, 403)
  await next()
})

// Complaints go to the chats that opted in via telegram_chats.receives_complaints
// — the support group and the support agent — not to every active chat. Mina and
// Eslam's thread is the approval queue; filling it with customer complaints would
// bury the thing it exists for.
//
// Best effort by design: a Telegram outage must never stop a complaint being
// recorded, so a send failure is reported back to the caller rather than thrown.
async function notifySupport(alertType: string, message: string): Promise<{ sent: number; error?: string }> {
  const { data: chats } = await db
    .from('telegram_chats').select('chat_id').eq('is_active', true).eq('receives_complaints', true)
  const chatIds = (chats ?? []).map((c) => String(c.chat_id))
  if (!chatIds.length) return { sent: 0, error: 'no_complaint_chats' }

  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return { sent: 0, error: 'telegram_not_configured' }
  try {
    const res = await fetch(`${baseUrl}/functions/v1/telegram-notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify({ alert_type: alertType, message, chat_ids: chatIds }),
    })
    const out = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) return { sent: 0, error: String(out.error ?? `HTTP ${res.status}`) }
    return { sent: Number(out.sent ?? 0) }
  } catch (e) {
    return { sent: 0, error: e instanceof Error ? e.message : 'send_failed' }
  }
}

const esc = (v: unknown): string =>
  String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function isNgPayGateway(value: unknown): boolean {
  const key = String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  return key.includes('nagupay') || key.includes('nagopay')
}

async function executeProviderDecision(txId: number, decision: 'PAID' | 'DECLINED', actorName: string, remark: string | null) {
  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return { ok: false, error: 'worker_not_configured' as const }
  const response = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
    body: JSON.stringify({ tx_id: txId, decision, actor_name: actorName, remark: remark ?? undefined }),
  })
  const result = await response.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
  if (!response.ok || result.executed_on_provider !== true) return { ok: false, error: 'worker_failed' as const, result }
  return { ok: true as const, result }
}

const audit = (actor: { sub: string; username: string }, action: string, entityId: string, after: Record<string, unknown>) =>
  db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action,
    entity: 'tx_complaints',
    entity_id: entityId,
    after,
  })

complaintRoutes.get('/', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const status = c.req.query('status')?.trim()
  const txIdRaw = c.req.query('tx_id')?.trim()
  const txId = txIdRaw && /^\d+$/.test(txIdRaw) ? txIdRaw : null
  if (txIdRaw && !txId) return c.json({ error: 'invalid_tx_id' }, 400)
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  let query = old
    .from('tx_complaints')
    .select('id, tx_id, customer_phone, amount, note, status, finding, created_at, resolved_at, admin_note', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (status) query = query.eq('status', status)
  if (txId) query = query.eq('tx_id', txId)
  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const complaintRows = data ?? []
  const txIds = [...new Set(complaintRows.map((row) => row.tx_id).filter((id): id is number => Number.isInteger(id)))]
  const txStatuses = txIds.length ? await old.from('maven_transactions').select('tx_id, status, gateway').in('tx_id', txIds) : { data: [] as { tx_id: number; status: string; gateway: string | null }[] }
  const statusByTx = new Map((txStatuses.data ?? []).map((row) => [Number(row.tx_id), row.status]))
  const gatewayByTx = new Map((txStatuses.data ?? []).map((row) => [Number(row.tx_id), row.gateway]))
  return c.json({ rows: complaintRows.map((row) => ({ ...row, tx_status: row.tx_id == null ? null : statusByTx.get(Number(row.tx_id)) ?? null, tx_gateway: row.tx_id == null ? null : gatewayByTx.get(Number(row.tx_id)) ?? null })), total: count ?? 0 })
})

complaintRoutes.post('/log', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const txId = body?.tx_id ? Number(body.tx_id) : null
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : null
  const amount = body?.amount != null ? Number(body.amount) : null
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  if (!phone && !txId) return c.json({ error: 'bad_request' }, 400)
  const { data, error } = await old.rpc('complaint_log', {
    p_tx_id: txId,
    p_phone: phone,
    p_amount: amount,
    p_note: note,
  })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await audit(actor, 'complaint.log', String(txId ?? phone), { phone, amount, note })

  // Keep a first-class support ticket in the panel database for every complaint.
  // The legacy complaint RPC remains the source of the complaint record; this
  // ticket is the operational queue and is intentionally best-effort.
  const complaintId = Number((data as Record<string, unknown> | null)?.id ?? (data as Record<string, unknown> | null)?.complaint_id)
  const priority = /urgent|asap|critical|failed|emergency/i.test(note ?? '') ? 'high' : txId ? 'medium' : 'normal'
  await db.from('support_tickets').insert({
    ticket_no: `TKT-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
    complaint_id: Number.isFinite(complaintId) ? complaintId : null,
    tx_id: txId, customer_phone: phone, amount, subject: txId ? `Transaction issue #${txId}` : 'Customer complaint',
    description: note, message_body: note, priority, opened_by: actor.username,
  })

  const tg = await notifySupport('complaint_filed', [
    '📣 <b>شكوى جديدة</b>',
    txId ? `المعاملة: <code>${esc(txId)}</code>` : null,
    phone ? `هاتف العميل: <code>${esc(phone)}</code>` : null,
    amount != null ? `المبلغ: <b>${esc(amount)}</b>` : null,
    note ? `التفاصيل: ${esc(note)}` : null,
    `سُجِّلت بواسطة: ${esc(actor.username)}`,
  ].filter(Boolean).join('\n'))

  // Say plainly whether it reached anyone — never imply a send that failed.
  return c.json({ ok: true, result: data, telegram: tg })
})

complaintRoutes.post('/investigate', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const { data, error } = await old.rpc('complaint_investigate', {
    p_tx_id: body?.tx_id ? Number(body.tx_id) : null,
    p_phone: typeof body?.phone === 'string' ? body.phone.trim() : null,
    p_amount: body?.amount != null ? Number(body.amount) : null,
  })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  return c.json({ ok: true, result: data })
})

// Bulk merchant-reference investigation. Reference1 is the only merchant
// reference; merchant_tx_reference mirrors tx_id and must never be used here.
complaintRoutes.post('/batch-investigate', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const references = Array.isArray(body?.references)
    ? [...new Set(body.references.map((value: unknown) => String(value).trim()).filter((value: string) => /^\d{11}$/.test(value)))].slice(0, 500)
    : []
  const master = body?.master_merchant === 'PayFuture' ? 'PayFuture' : 'NGPay'
  if (!references.length) return c.json({ error: 'no_valid_references' }, 400)
  const { data, error } = await old.rpc('investigate_merchant_complaints', {
    p_references: references,
    p_master_merchant: master,
  })
  if (error) return c.json({ error: 'investigation_failed', detail: error.message }, 500)
  return c.json(data ?? { masterMerchant: master, generatedAt: new Date().toISOString(), rows: [] })
})

const INVESTIGATION_ACTIONS = new Set(['approve_paid', 'link_sms', 'reject_complaint'])

complaintRoutes.post('/investigation-action', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const txId = Number(body?.tx_id)
  const smsId = body?.sms_id == null ? null : Number(body.sms_id)
  const action = String(body?.action ?? '')
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : null
  if (!Number.isInteger(txId) || !INVESTIGATION_ACTIONS.has(action)) return c.json({ error: 'bad_request' }, 400)
  if (action === 'link_sms' && !Number.isInteger(smsId)) return c.json({ error: 'sms_required' }, 400)

  const actor = c.get('actor')
  const { data: tx, error: txError } = await old.from('maven_transactions')
    .select('tx_id, status, amount, sender_number, receiving_wallet, to_account_number, created_utc, first_seen_at, raw')
    .eq('tx_id', txId).maybeSingle()
  if (txError || !tx) return c.json({ error: 'transaction_not_found' }, 404)

  if (action === 'link_sms') {
    const { data: sms, error: smsError } = await old.from('inbound_sms')
      .select('id, amount, sender_number, receiver_number, received_at, consumed_by_tx_id')
      .eq('id', smsId).maybeSingle()
    if (smsError || !sms) return c.json({ error: 'sms_not_found' }, 404)
    if (sms.consumed_by_tx_id != null && Number(sms.consumed_by_tx_id) !== txId) return c.json({ error: 'sms_already_consumed' }, 409)
    const wallet = tx.receiving_wallet || tx.to_account_number
    const createdAt = new Date(tx.created_utc || tx.first_seen_at).getTime()
    const receivedAt = new Date(sms.received_at).getTime()
    const safe = Number(sms.amount) === Number(tx.amount)
      && Boolean(wallet) && sms.receiver_number === wallet
      && Number.isFinite(createdAt) && Number.isFinite(receivedAt)
      && receivedAt >= createdAt - 15 * 60_000 && receivedAt <= createdAt + 90 * 60_000
      && (sms.sender_number == null || sms.sender_number === tx.sender_number)
    if (!safe) return c.json({ error: 'sms_match_rules_failed' }, 409)
    const { error } = await old.from('inbound_sms').update({
      consumed_by_tx_id: txId, matched_transaction_id: txId, matched: true,
      match_status: 'manual', review_required: false, processed_at: new Date().toISOString(),
    }).eq('id', smsId).is('consumed_by_tx_id', null)
    if (error) return c.json({ error: 'link_failed', detail: error.message }, 500)
  } else if (action === 'approve_paid') {
    const raw = tx.raw as Record<string, unknown> | null
    const gateway = raw?.Gateway ?? raw?.gateway
    if (isNgPayGateway(gateway) && String(tx.status ?? '').toUpperCase() === 'PENDING') {
      const provider = await executeProviderDecision(txId, 'PAID', actor.username, note)
      if (!provider.ok) return c.json({ error: provider.error, detail: provider.result }, 502)
    } else {
      // Non-NagoPay complaints retain the legacy RPC path.
      const { data, error } = await old.rpc('complaint_approve', {
        p_tx_id: txId, p_complaint_id: null, p_admin_note: note, p_target_status: 'PAID',
      })
      if (error) return c.json({ error: 'approve_failed', detail: error.message }, 500)
      await old.from('maven_transactions').update({ approved_by: actor.username }).eq('tx_id', txId)
      await db.from('maven_transactions').update({ status: 'PAID', approved_by: actor.username }).eq('tx_id', txId)
      void data
    }
  }

  const reference = String((tx.raw as Record<string, unknown> | null)?.Reference1 ?? '')
  await audit(actor, `complaint.investigation.${action}`, String(txId), {
    merchant_reference: reference, sms_id: smsId, note, previous_status: tx.status,
    target_status: action === 'approve_paid' ? 'PAID' : tx.status,
  })
  return c.json({ ok: true, tx_id: txId, action, actor: actor.username, recorded_at: new Date().toISOString() })
})

const DECISIONS: Record<string, string> = {
  approve: 'complaint_approve',
  decline: 'complaint_decline',
  close: 'complaint_close',
}

complaintRoutes.post('/:id/:decision', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const id = Number(c.req.param('id'))
  const decision = c.req.param('decision')
  const rpcName = DECISIONS[decision]
  if (!rpcName || !Number.isInteger(id)) return c.json({ error: 'bad_request' }, 400)
  const body = await c.req.json().catch(() => null)
  const txId = Number(body?.tx_id)
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
  if (!Number.isInteger(txId)) return c.json({ error: 'bad_tx_id' }, 400)

  const args: Record<string, unknown> = { p_tx_id: txId, p_complaint_id: id, p_admin_note: note }
  if (decision === 'approve') args.p_target_status = 'PAID'
  const actor = c.get('actor')
  const { data: tx } = await old.from('maven_transactions').select('status, gateway, raw').eq('tx_id', txId).maybeSingle()
  let data: unknown = null
  if ((decision === 'approve' || decision === 'decline') && isNgPayGateway(tx?.gateway ?? (tx?.raw as Record<string, unknown> | null)?.Gateway) && String(tx?.status ?? '').toUpperCase() === 'PENDING') {
    const provider = await executeProviderDecision(txId, decision === 'approve' ? 'PAID' : 'DECLINED', actor.username, note)
    if (!provider.ok) return c.json({ error: provider.error, detail: provider.result }, 502)
    data = provider.result
  } else {
    const rpcResult = await old.rpc(rpcName, args)
    if (rpcResult.error) return c.json({ error: 'rpc_error', detail: rpcResult.error.message }, 500)
    data = rpcResult.data
  }
  await audit(actor, `complaint.${decision}`, String(id), { tx_id: txId, note, result: data })

  const headline = decision === 'approve' ? '✅ شكوى: تمت الموافقة (المعاملة → PAID)'
    : decision === 'decline' ? '❌ شكوى: مرفوضة'
    : '📕 شكوى: مغلقة'
  const tg = await notifySupport('complaint_resolved', [
    `<b>${headline}</b>`,
    `رقم الشكوى: <code>${esc(id)}</code> · المعاملة: <code>${esc(txId)}</code>`,
    note ? `ملاحظة: ${esc(note)}` : null,
    `القرار بواسطة: ${esc(actor.username)}`,
  ].filter(Boolean).join('\n'))

  return c.json({ ok: true, result: data, telegram: tg })
})
