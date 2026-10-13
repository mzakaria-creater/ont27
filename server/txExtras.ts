import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Operator notes and safe local flags on a transaction (hold from settlement,
// send to review). These never touch the provider; every change is audited.
export const txExtrasRoutes = new Hono<AuthEnv>()
txExtrasRoutes.use('*', requireAuth)

const viewPerm = requireAnyPerm(['deposits', 'transactions', 'all_transactions'], 'can_view')
const actPerm = requireAnyPerm(['deposits', 'transactions', 'all_transactions'], 'can_approve')
const idOf = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : null }

txExtrasRoutes.get('/:txId/notes', viewPerm, async (c) => {
  const txId = idOf(c.req.param('txId')); if (txId == null) return c.json({ error: 'invalid_tx_id' }, 400)
  const { data, error } = await db.from('transaction_notes').select('id, author, note, created_at').eq('tx_id', txId).order('created_at', { ascending: false }).limit(100)
  if (error) return c.json({ error: 'db_error' }, 500)
  return c.json({ notes: data ?? [] })
})

txExtrasRoutes.post('/:txId/notes', viewPerm, async (c) => {
  const txId = idOf(c.req.param('txId')); if (txId == null) return c.json({ error: 'invalid_tx_id' }, 400)
  const body = await c.req.json().catch(() => null)
  const note = typeof body?.note === 'string' ? body.note.trim() : ''
  if (!note || note.length > 2000) return c.json({ error: 'invalid_note' }, 400)
  const actor = c.get('actor')
  const { data, error } = await db.from('transaction_notes').insert({ tx_id: txId, author: actor.username, note }).select('id, author, note, created_at').single()
  if (error) return c.json({ error: 'db_error' }, 500)
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: 'transaction.note_added', entity: 'transaction', entity_id: String(txId), after: { note } })
  return c.json({ note: data })
})

const flag = (column: 'settlement_blocked' | 'needs_review', action: string) => async (c: any) => {
  const txId = idOf(c.req.param('txId')); if (txId == null) return c.json({ error: 'invalid_tx_id' }, 400)
  const body = await c.req.json().catch(() => null)
  const value = body?.value !== false
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const { data: before } = await db.from('maven_transactions').select(`tx_id, ${column}`).eq('tx_id', txId).maybeSingle()
  if (!before) return c.json({ error: 'not_found' }, 404)
  const { error } = await db.from('maven_transactions').update({ [column]: value }).eq('tx_id', txId)
  if (error) return c.json({ error: 'db_error' }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'panel_user', actor_id: actor.sub, actor_name: actor.username, action: `transaction.${action}${value ? '' : '_cleared'}`, entity: 'transaction', entity_id: String(txId), before: { [column]: (before as any)[column] }, after: { [column]: value, reason } })
  return c.json({ ok: true, [column]: value })
}
txExtrasRoutes.post('/:txId/hold', actPerm, flag('settlement_blocked', 'hold'))
txExtrasRoutes.post('/:txId/review', actPerm, flag('needs_review', 'sent_to_review'))
