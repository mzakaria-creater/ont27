import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Same short-code/token scheme as payment_links (server/links.ts) — kept in
// sync deliberately so payin and payout links behave identically to whoever
// manages them.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function newShortCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

function newCheckoutToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex')
  return { raw, hash: createHash('sha256').update(raw).digest('hex') }
}

const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)

export const payoutLinkRoutes = new Hono<AuthEnv>()
payoutLinkRoutes.use('*', requireAuth)

payoutLinkRoutes.get('/', requirePerm('payouts', 'can_view'), async (c) => {
  const [{ data: links, error }, { data: requests }] = await Promise.all([
    db.from('payout_links').select('*').order('created_at', { ascending: false }),
    db.from('payout_link_requests').select('payout_link_id, status, amount'),
  ])
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  const stats = new Map<string, { pending: number; converted: number; rejected: number; total_amount: number }>()
  for (const r of requests ?? []) {
    const key = r.payout_link_id as string
    const row = stats.get(key) ?? { pending: 0, converted: 0, rejected: 0, total_amount: 0 }
    if (r.status === 'pending') row.pending += 1
    else if (r.status === 'converted') { row.converted += 1; row.total_amount += Number(r.amount) || 0 }
    else if (r.status === 'rejected') row.rejected += 1
    stats.set(key, row)
  }
  const now = Date.now()
  const statusOf = (l: Record<string, unknown>): string => {
    if (!l.active) return 'disabled'
    if (l.expires_at && new Date(l.expires_at as string).getTime() < now) return 'expired'
    if (l.max_uses !== null && Number(l.use_count) >= Number(l.max_uses)) return 'exhausted'
    return 'active'
  }
  return c.json({
    links: (links ?? []).map((l) => ({
      ...l,
      status: statusOf(l as Record<string, unknown>),
      stats: stats.get(l.id) ?? { pending: 0, converted: 0, rejected: 0, total_amount: 0 },
    })),
  })
})

payoutLinkRoutes.post('/', requirePerm('payouts', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const amountMode = body?.amount_mode === 'fixed' ? 'fixed' : 'open'
  const amount = num(body?.amount)
  if (amountMode === 'fixed' && !amount) return c.json({ error: 'fixed_needs_amount' }, 400)
  const checkoutToken = newCheckoutToken()
  const { data: link, error } = await db.from('payout_links').insert({
    short_code: newShortCode(),
    title: typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : null,
    merchant_id: typeof body?.merchant_id === 'string' && body.merchant_id ? body.merchant_id : null,
    client_name: typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : null,
    amount_mode: amountMode,
    amount: amountMode === 'fixed' ? amount : null,
    min_amount: amountMode === 'open' ? num(body?.min_amount) : null,
    max_amount: amountMode === 'open' ? num(body?.max_amount) : null,
    currency: typeof body?.currency === 'string' && body.currency ? body.currency : 'EGP',
    expires_at: body?.expires_at ? new Date(body.expires_at).toISOString() : null,
    max_uses: Number.isInteger(Number(body?.max_uses)) && Number(body.max_uses) > 0 ? Number(body.max_uses) : null,
    created_by: c.get('actor').sub,
    checkout_token_hash: checkoutToken.hash,
  }).select('*').single()
  if (error || !link) return c.json({ error: 'link_create_failed', detail: error?.message }, 500)
  return c.json({ link, payout_url: `/payout-checkout?token=${checkoutToken.raw}` }, 201)
})

payoutLinkRoutes.patch('/:id', requirePerm('payouts', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body?.active === 'boolean') updates.active = body.active
  if (typeof body?.title === 'string') updates.title = body.title.trim() || null
  if (typeof body?.client_name === 'string') updates.client_name = body.client_name.trim() || null
  const { data: link, error } = await db.from('payout_links').update(updates).eq('id', c.req.param('id')).select('*').maybeSingle()
  if (error || !link) return c.json({ error: 'link_not_found' }, 404)
  return c.json({ link })
})

payoutLinkRoutes.post('/:id/expire', requirePerm('payouts', 'can_create'), async (c) => {
  const { data: link, error } = await db.from('payout_links').update({ expires_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', c.req.param('id')).select('*').maybeSingle()
  if (error || !link) return c.json({ error: 'link_not_found' }, 404)
  return c.json({ link })
})

// Issue a fresh share token whenever an operator presses Copy — mirrors
// payment_links/:id/token exactly. Only the SHA-256 digest is persisted; the
// raw token is returned once and the previous short code/token stop working.
payoutLinkRoutes.post('/:id/token', requirePerm('payouts', 'can_create'), async (c) => {
  const checkoutToken = newCheckoutToken()
  const { data: link, error } = await db.from('payout_links').update({
    short_code: newShortCode(),
    checkout_token_hash: checkoutToken.hash,
    updated_at: new Date().toISOString(),
  }).eq('id', c.req.param('id')).select('*').maybeSingle()
  if (error || !link) return c.json({ error: 'link_not_found' }, 404)
  return c.json({ link, payout_url: `/payout-checkout?token=${checkoutToken.raw}` })
})
