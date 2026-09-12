import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { db } from './db.js'
import { allocateWallet } from './allocate.js'
import { notifyTelegram } from './notify.js'

const SESSION_TTL_MIN = 15

interface LinkRow {
  id: string
  merchant_id: string | null
  short_code: string
  title: string | null
  amount_mode: 'fixed' | 'open'
  amount: number | null
  min_amount: number | null
  max_amount: number | null
  currency: string
  expires_at: string | null
  max_uses: number | null
  use_count: number
  active: boolean
  client_name?: string | null
  client_reference?: string | null
  return_url?: string | null
  payment_method_codes?: string[] | null
  wallet_pool_id?: string | null
  allocation_mode?: 'single_queue' | 'multi_wallet'
  multi_wallet_threshold?: number | null
}

function linkUsable(link: LinkRow): string | null {
  if (!link.active) return 'link_disabled'
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return 'link_expired'
  if (link.max_uses !== null && link.use_count >= link.max_uses) return 'link_exhausted'
  return null
}

// Salted daily digest of IP + user agent. Enough to tell one visitor from
// another within a day; not reversible into an address, and it rolls over
// nightly so it cannot be joined across days into a browsing history. The
// salt is the JWT secret, which is already required to be set — with no
// secret the digest is skipped entirely rather than falling back to something
// predictable that would let anyone reconstruct the input.
function visitorDigest(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const salt = process.env.PANEL_JWT_SECRET
  if (!salt) return null
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip') ?? ''
  const ua = c.req.header('user-agent') ?? ''
  if (!ip && !ua) return null
  const day = new Date().toISOString().slice(0, 10)
  return createHash('sha256').update(`${salt}|${day}|${ip}|${ua}`).digest('hex').slice(0, 32)
}

// Recorded for EVERY view, refused ones included: a link nobody can use any
// more but that people keep opening is the single most useful thing this
// table can show, and it is invisible if only successful views are kept.
// Never allowed to fail the request — an analytics write must not stop a
// customer reaching a payment page.
async function recordOpen(
  link: { id: string; short_code: string },
  blockedReason: string | null,
  c: { req: { header: (k: string) => string | undefined } },
): Promise<void> {
  try {
    await db.from('payment_link_opens').insert({
      link_id: link.id,
      short_code: link.short_code,
      visitor_hash: visitorDigest(c),
      blocked_reason: blockedReason,
    })
  } catch (e) {
    console.error('payment_link_opens insert failed:', e)
  }
}

function publicSession(s: Record<string, unknown>) {
  const meta = (s.metadata ?? {}) as Record<string, unknown>
  const expired =
    s.status === 'pending' && s.expires_at && new Date(s.expires_at as string).getTime() < Date.now()
  return {
    id: s.id,
    reference: s.reference,
    status: expired ? 'expired' : s.status,
    amount: s.amount,
    currency: s.currency,
    customer_phone: s.customer_phone,
    wallet_number: meta.wallet_number ?? null,
    provider: meta.provider ?? null,
    channel_name: meta.channel_name ?? null,
    deeplink: meta.deeplink ?? null,
    wallets: meta.wallets ?? null,
    return_url: s.success_url ?? meta.return_url ?? null,
    merchant_name: meta.merchant_name ?? null,
    created_at: s.created_at,
    expires_at: s.expires_at,
    paid_at: s.paid_at,
  }
}

export const payRoutes = new Hono()

payRoutes.get('/link/:code', async (c) => {
  const { data: link } = await db
    .from('payment_links')
    .select('*')
    .eq('short_code', c.req.param('code'))
    .maybeSingle<LinkRow>()
  if (!link) return c.json({ error: 'link_not_found' }, 404)
  const unusable = linkUsable(link)
  await recordOpen(link, unusable, c)
  if (unusable) return c.json({ error: unusable }, 410)
  return c.json({
    link: {
      short_code: link.short_code,
      title: link.title,
      amount_mode: link.amount_mode,
      amount: link.amount,
      min_amount: link.min_amount,
      max_amount: link.max_amount,
      currency: link.currency,
      client_name: link.client_name ?? null,
      client_reference: link.client_reference ?? null,
      return_url: link.return_url ?? null,
      payment_method_codes: link.payment_method_codes ?? [],
      allocation_mode: link.allocation_mode ?? 'single_queue',
      multi_wallet_threshold: link.multi_wallet_threshold ?? null,
    },
  })
})

payRoutes.post('/session', async (c) => {
  const body = await c.req.json().catch(() => null)
  const code = typeof body?.code === 'string' ? body.code.trim() : null
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : null
  const requestedMethod = typeof body?.payment_method_code === 'string' ? body.payment_method_code.trim().toUpperCase() : null
  const rawAmount = Number(body?.amount)

  if (!/^01[0-9]{9}$/.test(phone)) return c.json({ error: 'invalid_phone' }, 400)

  let link: LinkRow | null = null
  if (code) {
    const { data } = await db
      .from('payment_links')
      .select('*')
      .eq('short_code', code)
      .maybeSingle<LinkRow>()
    if (!data) return c.json({ error: 'link_not_found' }, 404)
    const unusable = linkUsable(data)
    if (unusable) return c.json({ error: unusable }, 410)
    link = data
  }

  const currency = link?.currency ?? 'EGP'
  let amount = link?.amount_mode === 'fixed' ? Number(link.amount) : rawAmount
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_amount' }, 400)
  amount = Math.round(amount * 100) / 100
  if (link?.amount_mode === 'open') {
    if (link.min_amount !== null && amount < link.min_amount) return c.json({ error: 'amount_below_min', min: link.min_amount }, 400)
    if (link.max_amount !== null && amount > link.max_amount) return c.json({ error: 'amount_above_max', max: link.max_amount }, 400)
  }

  const allowedMethods = (link?.payment_method_codes ?? []).map((method) => method.toUpperCase())
  if (requestedMethod && allowedMethods.length && !allowedMethods.includes(requestedMethod)) {
    return c.json({ error: 'payment_method_not_allowed' }, 400)
  }

  const wallet = await allocateWallet(currency, {
    poolId: link?.wallet_pool_id,
    methodCodes: requestedMethod ? [requestedMethod] : allowedMethods,
    amount,
    mode: link?.allocation_mode,
    multiWalletThreshold: link?.multi_wallet_threshold,
  })
  if (!wallet) return c.json({ error: 'no_channel_available' }, 503)

  if (link) {
    const { data: used, error } = await db.rpc('use_payment_link', { p_link_id: link.id })
    if (error || used === null) return c.json({ error: 'link_exhausted' }, 410)
  }

  const reference = `OT-${randomBytes(5).toString('hex').toUpperCase()}`
  const deeplink = wallet.deeplinkTemplate
    ?.replaceAll('{wallet}', wallet.walletNumber)
    .replaceAll('{amount}', String(amount)) ?? null

  const { data: session, error } = await db
    .from('checkout_sessions')
    .insert({
      merchant_id: link?.merchant_id ?? null,
      payment_link_id: link?.id ?? null,
      reference,
      status: 'pending',
      amount,
      currency,
      pay_currency: currency,
      pay_amount: amount,
      customer_phone: phone,
      customer_name: name,
      local_deposit_channel_id: wallet.channelId,
      payment_method_id: wallet.paymentMethodId ?? null,
      wallet_id: wallet.accountId ?? null,
      success_url: link?.return_url ?? null,
      expires_at: new Date(Date.now() + SESSION_TTL_MIN * 60_000).toISOString(),
      metadata: {
        wallet_number: wallet.walletNumber,
        provider: wallet.provider,
        device: wallet.device,
        channel_name: wallet.channelName,
        channel_type: wallet.channelType,
        deeplink,
        wallets: wallet.allocations ?? null,
        return_url: link?.return_url ?? null,
        merchant_name: link?.client_name ?? null,
        client_reference: link?.client_reference ?? null,
        payment_method_code: wallet.paymentMethodCode ?? requestedMethod ?? null,
      },
    })
    .select('*')
    .single()
  if (error || !session) {
    console.error('session insert failed:', error?.message)
    return c.json({ error: 'session_create_failed' }, 500)
  }

  void notifyTelegram(
    `🟡 طلب إيداع جديد\nRef: <code>${reference}</code>\nAmount: ${amount} ${currency}\nWallet: <code>${wallet.walletNumber}</code> (${wallet.device})\nPhone: <code>${phone}</code>`,
  )

  return c.json({ session: publicSession(session) }, 201)
})

payRoutes.get('/session/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'not_found' }, 404)
  const { data: session } = await db
    .from('checkout_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!session) return c.json({ error: 'not_found' }, 404)
  return c.json({ session: publicSession(session) })
})
