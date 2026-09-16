import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Unambiguous alphabet (no 0/O/1/I) for short codes shared over chat apps.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const positiveNumber = (value: unknown): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

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
  const checkoutToken = newCheckoutToken()

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
      client_name: src.client_name,
      client_reference: src.client_reference,
      return_url: src.return_url,
      payment_method_codes: src.payment_method_codes ?? [],
      wallet_pool_id: src.wallet_pool_id,
      allocation_mode: src.allocation_mode ?? 'single_queue',
      multi_wallet_threshold: src.multi_wallet_threshold,
      require_name: src.require_name === true,
      created_by: c.get('actor').sub,
      checkout_token_hash: checkoutToken.hash,
    })
    .select('*')
    .single()
  if (error || !link) {
    console.error('link duplicate failed:', error?.message)
    return c.json({ error: 'link_duplicate_failed' }, 500)
  }
  return c.json({ link, checkout_url: `/payment-checkout?token=${checkoutToken.raw}`, copiedFrom: src.short_code }, 201)
})

linkRoutes.get('/merchants', requirePerm('checkout-builder', 'can_view'), async (c) => {
  const [{ data: merchants }, { data: methods }, { data: pools }, { data: masters }] = await Promise.all([
    db.from('merchants').select('id, name, code, "MID", master_merchant_id').eq('active', true).order('name'),
    db.from('payment_methods').select('id, method_code, method_name, channel_type').eq('is_active', true).order('sort_order').order('method_name'),
    db.from('payment_pools').select('id, pool_name, pool_code, allocation_strategy, rotation_enabled').eq('is_active', true).order('pool_name'),
    db.from('master_merchants').select('id, name, code, mid').order('name'),
  ])
  return c.json({ merchants: merchants ?? [], masters: masters ?? [], methods: methods ?? [], pools: pools ?? [] })
})

linkRoutes.post('/', requirePerm('checkout-builder', 'can_create'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const amountMode = body?.amount_mode === 'fixed' ? 'fixed' : 'open'
  const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)

  const amount = num(body?.amount)
  if (amountMode === 'fixed' && !amount) return c.json({ error: 'fixed_needs_amount' }, 400)
  const checkoutToken = newCheckoutToken()

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
      client_name: typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : null,
      client_reference: typeof body?.client_reference === 'string' && body.client_reference.trim() ? body.client_reference.trim() : null,
      return_url: typeof body?.return_url === 'string' && /^https?:\/\//i.test(body.return_url.trim()) ? body.return_url.trim() : null,
      payment_method_codes: Array.isArray(body?.payment_method_codes) ? body.payment_method_codes.filter((x: unknown): x is string => typeof x === 'string').slice(0, 20) : [],
      wallet_pool_id: typeof body?.wallet_pool_id === 'string' && body.wallet_pool_id ? body.wallet_pool_id : null,
      allocation_mode: body?.allocation_mode === 'multi_wallet' ? 'multi_wallet' : 'single_queue',
      multi_wallet_threshold: positiveNumber(body?.multi_wallet_threshold),
      require_name: body?.require_name === true,
      created_by: c.get('actor').sub,
      checkout_token_hash: checkoutToken.hash,
    })
    .select('*')
    .single()
  if (error || !link) {
    console.error('link create failed:', error?.message)
    return c.json({ error: 'link_create_failed' }, 500)
  }
  return c.json({ link, checkout_url: `/payment-checkout?token=${checkoutToken.raw}` }, 201)
})

linkRoutes.patch('/:id', requirePerm('checkout-builder', 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body?.active === 'boolean') updates.active = body.active
  if (typeof body?.title === 'string') updates.title = body.title.trim() || null
  if (typeof body?.client_name === 'string') updates.client_name = body.client_name.trim() || null
  if (typeof body?.client_reference === 'string') updates.client_reference = body.client_reference.trim() || null
  if (typeof body?.return_url === 'string' && /^https?:\/\//i.test(body.return_url.trim())) updates.return_url = body.return_url.trim()
  if (Array.isArray(body?.payment_method_codes)) updates.payment_method_codes = body.payment_method_codes.filter((x: unknown): x is string => typeof x === 'string').slice(0, 20)
  if (typeof body?.wallet_pool_id === 'string' || body?.wallet_pool_id === null) updates.wallet_pool_id = body.wallet_pool_id || null
  if (body?.allocation_mode === 'single_queue' || body?.allocation_mode === 'multi_wallet') updates.allocation_mode = body.allocation_mode
  if (body?.multi_wallet_threshold !== undefined) updates.multi_wallet_threshold = positiveNumber(body.multi_wallet_threshold)
  if (typeof body?.require_name === 'boolean') updates.require_name = body.require_name
  const { data: link, error } = await db
    .from('payment_links')
    .update(updates)
    .eq('id', c.req.param('id'))
    .select('*')
    .maybeSingle()
  if (error || !link) return c.json({ error: 'link_not_found' }, 404)
  return c.json({ link })
})
