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
  return c.json({
    links: (links ?? []).map((l) => ({ ...l, stats: stats.get(l.id) ?? { sessions: 0, paid: 0, paid_amount: 0 } })),
  })
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
