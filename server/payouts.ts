import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Payouts = maven_payout_transactions. Key column is maven_id (Maven's id);
// ontarget_ref is OUR reference and is what the panel surfaces first.
// Observed statuses: PENDING | APPROVED | DECLINED. Amounts are EGP —
// the table has no currency column (currency lives in maven_raw_row).

export const payoutRoutes = new Hono<AuthEnv>()

payoutRoutes.use('*', requireAuth)

const LIST_COLUMNS =
  'maven_id, guid, ontarget_ref, status, amount, pay_by, merchant, account_name, mobile_no, agent_name, commission, remark, image_url, approved_by, created_utc, first_seen_at, last_seen_at'

const PROOF_BUCKET = 'pop'
const PROOF_PREFIX = 'payout-proofs/'

payoutRoutes.get('/', requirePerm('payouts', 'can_view'), async (c) => {
  const status = c.req.query('status')?.toUpperCase()
  const q = c.req.query('q')?.trim()
  const limit = Math.min(Number(c.req.query('limit')) || 25, 100)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)

  let query = db
    .from('maven_payout_transactions')
    .select(LIST_COLUMNS, { count: 'exact' })
    .order('ontarget_ref', { ascending: false, nullsFirst: false })
    .order('maven_id', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('status', status)
  if (q) {
    const like = `%${q.replaceAll(',', ' ')}%`
    const ors = [
      `ontarget_ref.ilike.${like}`,
      `mobile_no.ilike.${like}`,
      `account_name.ilike.${like}`,
      `merchant.ilike.${like}`,
      `agent_name.ilike.${like}`,
    ]
    if (/^\d+$/.test(q)) ors.push(`maven_id.eq.${q}`)
    query = query.or(ors.join(','))
  }

  const { data, count, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [], total: count ?? 0, limit, offset })
})

payoutRoutes.get('/:mavenId', requirePerm('payouts', 'can_view'), async (c) => {
  const mavenId = c.req.param('mavenId')
  if (!/^\d+$/.test(mavenId)) return c.json({ error: 'bad_id' }, 400)
  const { data, error } = await db
    .from('maven_payout_transactions')
    .select('*')
    .eq('maven_id', mavenId)
    .maybeSingle()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ payout: data })
})

payoutRoutes.post('/proof', requirePerm('payouts', 'can_approve'), async (c) => {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File) || file.size < 1) return c.json({ error: 'proof_file_required' }, 400)
  if (file.size > 10 * 1024 * 1024) return c.json({ error: 'proof_file_too_large' }, 400)
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) {
    return c.json({ error: 'invalid_proof_type' }, 400)
  }

  const actor = c.get('actor')
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'proof'
  const path = `${PROOF_PREFIX}${actor.sub}/${Date.now()}-${safeName}`
  const { error } = await db.storage.from(PROOF_BUCKET).upload(path, new Uint8Array(await file.arrayBuffer()), {
    contentType: file.type,
    upsert: false,
  })
  if (error) return c.json({ error: 'proof_upload_failed', detail: error.message }, 500)
  const { data } = db.storage.from(PROOF_BUCKET).getPublicUrl(path)
  return c.json({ proof_url: data.publicUrl, path })
})

payoutRoutes.post('/:mavenId/decision', requirePerm('payouts', 'can_approve'), async (c) => {
  const mavenId = c.req.param('mavenId')
  if (!/^\d+$/.test(mavenId)) return c.json({ error: 'bad_id' }, 400)

  const body = await c.req.json().catch(() => null)
  const decision = body?.decision as 'APPROVED' | 'DECLINED' | undefined
  const remark = typeof body?.remark === 'string' ? body.remark.slice(0, 500) : undefined
  const proofUrl = typeof body?.proof_url === 'string' ? body.proof_url.trim() : undefined
  if (decision !== 'APPROVED' && decision !== 'DECLINED') return c.json({ error: 'bad_decision' }, 400)
  if (decision === 'APPROVED' && !proofUrl) return c.json({ error: 'proof_url_required' }, 400)
  const baseUrl = process.env.SUPABASE_URL
  const allowedProofPrefix = `${baseUrl}/storage/v1/object/public/${PROOF_BUCKET}/${PROOF_PREFIX}`
  if (proofUrl && !proofUrl.startsWith(allowedProofPrefix)) return c.json({ error: 'invalid_proof_url' }, 400)

  const { data: before, error: readErr } = await db
    .from('maven_payout_transactions')
    .select('maven_id, status, amount, ontarget_ref, merchant')
    .eq('maven_id', mavenId)
    .maybeSingle()
  if (readErr) return c.json({ error: 'db_error', detail: readErr.message }, 500)
  if (!before) return c.json({ error: 'not_found' }, 404)
  if (before.status !== 'PENDING') {
    return c.json({ error: 'not_pending', status: before.status }, 409)
  }

  // The worker is the only path allowed to record a payout decision. It writes
  // payout_decision_log before its own controlled update and always discloses
  // that provider execution remains manual.
  const actor = c.get('actor')
  const workerUrl = `${baseUrl}/functions/v1/payout-decision-worker`
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!baseUrl || !serviceKey) return c.json({ error: 'worker_not_configured' }, 500)
  const workerResponse = await fetch(workerUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      maven_id: Number(mavenId), decision, actor_name: actor.username,
      proof_url: proofUrl, remark,
    }),
  })
  const workerResult = await workerResponse.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
  if (!workerResponse.ok) return c.json({ error: 'worker_failed', worker: workerResult }, workerResponse.status as 400 | 401 | 403 | 404 | 409 | 500)
  return c.json({ ...workerResult, executed_on_provider: false, note: workerResult.note ?? 'Decision recorded only; provider execution remains manual.' })
})
