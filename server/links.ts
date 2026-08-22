import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Unambiguous alphabet (no 0/O/1/I) for short codes shared over chat apps.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function newShortCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

export const linkRoutes = new Hono<AuthEnv>()

linkRoutes.use('*', requireAuth)

linkRoutes.get('/', requirePerm('checkout-builder', 'can_view'), async (c) => {
  const [{ data: links }, { data: sessions }] = await Promise.all([
    db.from('payment_links').select('*').order('created_at', { ascending: false }),
    db.from('checkout_sessions').select('payment_link_id, status, amount').not('payment_link_id', 'is', null),
  ])
  const stats = new Map<string, { sessions: number; paid: number; paid_amount: number }>()
  for (const s of sessions ?? []) {
    const key = s.payment_link_id as string
    const row = stats.get(key) ?? { sessions: 0, paid: 0, paid_amount: 0 }
    row.sessions += 1
    if (s.status === 'approved') { row.paid += 1; row.paid_amount += Number(s.amount) || 0 }
    stats.set(key, row)
  }
  // Opens, distinct visitors, both conversion rates, and which methods people
  // actually chose. Best-effort: the list of links is the point of the page,
  // so missing analytics degrades the page rather than emptying it.
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365)
  let analytics: Record<string, unknown> = {}
  const { data: an, error: anErr } = await db.rpc('payment_link_analytics', { p_days: days })
  if (anErr) console.error('payment_link_analytics failed:', anErr.message)
  else analytics = ((an as Record<string, unknown>)?.byLink as Record<string, unknown>) ?? {}

  // Status is derived, never stored: a link becomes expired by the clock
  // passing, and exhausted by its last use. Persisting either would need a job
  // to keep it true and would be wrong in between runs.
  const now = Date.now()
  const statusOf = (l: Record<string, unknown>): string => {
    if (!l.active) return 'disabled'
    if (l.expires_at && new Date(l.expires_at as string).getTime() < now) return 'expired'
    if (l.max_uses !== null && Number(l.use_count) >= Number(l.max_uses)) return 'exhausted'
    return 'active'
  }

  return c.json({
    days,
    links: (links ?? []).map((l) => ({
      ...l,
      status: statusOf(l as Record<string, unknown>),
      stats: stats.get(l.id) ?? { sessions: 0, paid: 0, paid_amount: 0 },
      analytics: analytics[l.id] ?? null,
    })),
  })
})

// Expire a link now. Distinct from active=false: disabling is a reversible
// switch an operator can flip back, while expiry is a point in time that has
// passed. Keeping them apart means the list can say WHY a link stopped
// working instead of showing every dead link the same way.
linkRoutes.post('/:id/expire', requirePerm('checkout-builder', 'can_edit'), async (c) => {
  const { data: link, error } = await db
    .from('payment_links')
    .update({ expires_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .select('*')
    .maybeSingle()
  if (error || !link) return c.json({ error: 'link_not_found' }, 404)
  return c.json({ link })
})

// Duplicate a link: same configuration, fresh short code, counters reset.
//
// use_count and expires_at are deliberately NOT copied. A duplicate exists to
// be used, and inheriting the original's exhausted counter or a date already
// in the past would produce a link that is dead the moment it is created.
linkRoutes.post('/:id/duplicate', requirePerm('checkout-builder', 'can_create'), async (c) => {
  const { data: src, error: srcErr } = await db
    .from('payment_links').select('*').eq('id', c.req.param('id')).maybeSingle()
  if (srcErr || !src) return c.json({ error: 'link_not_found' }, 404)

  const { data: link, error } = await db
    .from('payment_links')
    .insert({
      short_code: newShortCode(),
      title: src.title ? `${src.title} (copy)` : null,
      merchant_id: src.merchant_id,
      amount_mode: src.amount_mode,
      amount: src.amount,
      min_amount: src.min_amount,
      max_amount: src.max_amount,
      currency: src.currency,
      max_uses: src.max_uses,
      created_by: c.get('actor').sub,
    })
    .select('*')
    .single()
  if (error || !link) {
    console.error('link duplicate failed:', error?.message)
    return c.json({ error: 'link_duplicate_failed' }, 500)
  }
  return c.json({ link, copiedFrom: src.short_code }, 201)
})

linkRoutes.get('/merchants', requirePerm('checkout-builder', 'can_view'), async (c) => {
  const { data } = await db
    .from('merchants').select('id, name, code').eq('active', true).order('name')
  return c.json({ merchants: data ?? [] })
})

linkRoutes.post('/', requirePerm('checkout-builder', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const amountMode = body?.amount_mode === 'fixed' ? 'fixed' : 'open'
  const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)

  const amount = num(body?.amount)
  if (amountMode === 'fixed' && !amount) return c.json({ error: 'fixed_needs_amount' }, 400)

  const { data: link, error } = await db
    .from('payment_links')
    .insert({
      short_code: newShortCode(),
      title: typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : null,
      merchant_id: typeof body?.merchant_id === 'string' && body.merchant_id ? body.merchant_id : null,
      amount_mode: amountMode,
      amount: amountMode === 'fixed' ? amount : null,
      min_amount: amountMode === 'open' ? num(body?.min_amount) : null,
      max_amount: amountMode === 'open' ? num(body?.max_amount) : null,
      currency: typeof body?.currency === 'string' && body.currency ? body.currency : 'EGP',
      expires_at: body?.expires_at ? new Date(body.expires_at).toISOString() : null,
      max_uses: Number.isInteger(Number(body?.max_uses)) && Number(body.max_uses) > 0 ? Number(body.max_uses) : null,
      created_by: c.get('actor').sub,
    })
    .select('*')
    .single()
  if (error || !link) {
    console.error('link create failed:', error?.message)
    return c.json({ error: 'link_create_failed' }, 500)
  }
  return c.json({ link }, 201)
})

linkRoutes.patch('/:id', requirePerm('checkout-builder', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body?.active === 'boolean') updates.active = body.active
  if (typeof body?.title === 'string') updates.title = body.title.trim() || null
  const { data: link, error } = await db
    .from('payment_links')
    .update(updates)
    .eq('id', c.req.param('id'))
    .select('*')
    .maybeSingle()
  if (error || !link) return c.json({ error: 'link_not_found' }, 404)
  return c.json({ link })
})
