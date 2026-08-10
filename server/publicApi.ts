import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { db } from './db.js'
import { sha256Hex } from './tokens.js'

// Developer-facing REST API (§1.3, built inside ont27 per the 2026-08-10
// decision — reuses merchant_api_keys + maven_transactions, no dependency on
// the legacy api.ontarget-egy.com service or the old DB).
//
// Auth: the merchant presents its SECRET (ots_<env>_...) as a Bearer token or
// X-API-Secret header. We sha256 it and match merchant_api_keys.secret_hash.
// Only public/safe columns are ever returned — never api_key/secret_key/etc.

type PubEnv = { Variables: { merchantId: string; keyEnv: string; keyId: string } }

const MERCHANT_SAFE =
  'id, name, code, "MID", status, is_active, active, kyc_status, business_type, country, country_code, base_currency, website, master_merchant_id, created_at'

const authMerchant = createMiddleware<PubEnv>(async (c, next) => {
  const auth = c.req.header('authorization') ?? ''
  const secret = c.req.header('x-api-secret')?.trim()
    || (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '')
  if (!secret) return c.json({ error: 'unauthorized', message: 'Missing API secret (Bearer token or X-API-Secret).' }, 401)

  const { data: key } = await db
    .from('merchant_api_keys')
    .select('id, merchant_id, environment, is_active, revoked_at, expires_at')
    .eq('secret_hash', sha256Hex(secret))
    .maybeSingle()

  const now = Date.now()
  const valid = key && key.is_active && !key.revoked_at && (!key.expires_at || new Date(key.expires_at).getTime() > now)
  if (!valid) return c.json({ error: 'unauthorized', message: 'Invalid, inactive, revoked, or expired API key.' }, 401)

  c.set('merchantId', key.merchant_id)
  c.set('keyEnv', key.environment)
  c.set('keyId', key.id)
  // Usage bookkeeping — fire and forget.
  void db.rpc('increment_api_key_usage', { p_id: key.id }).then(({ error }) => {
    if (error) void db.from('merchant_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id)
  })
  await next()
})

export const publicApiRoutes = new Hono<PubEnv>()

publicApiRoutes.get('/', (c) => c.json({
  service: 'OnTarget API', version: 'v1', status: 'ok',
  endpoints: { merchants: '/api/v1/merchants', transactions: '/api/v1/transactions', stats: '/api/v1/stats' },
}))

publicApiRoutes.use('/merchants', authMerchant)
publicApiRoutes.use('/merchants/*', authMerchant)
publicApiRoutes.use('/transactions', authMerchant)
publicApiRoutes.use('/stats', authMerchant)

// The authenticated merchant's own record (a key never exposes other merchants).
publicApiRoutes.get('/merchants', async (c) => {
  const { data, error } = await db.from('merchants').select(MERCHANT_SAFE).eq('id', c.get('merchantId')).maybeSingle()
  if (error) return c.json({ error: 'internal_error' }, 500)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return c.json({ data })
})

// This merchant's deposits from maven_transactions (the single source of
// truth). Mapping merchant_id -> transaction rows is by the merchant's name
// (maven_transactions.merchant is a text label), documented as best-effort.
publicApiRoutes.get('/transactions', async (c) => {
  const { data: m } = await db.from('merchants').select('name, code').eq('id', c.get('merchantId')).maybeSingle()
  if (!m) return c.json({ error: 'not_found' }, 404)
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
  const status = c.req.query('status')?.trim()
  let q = db.from('maven_transactions')
    .select('ontarget_ref, status, amount, currency, payment_method, master_merchant, sub_merchant, created_utc, first_seen_at')
    .eq('merchant', m.name)
    .order('first_seen_at', { ascending: false })
    .limit(limit)
  if (status) q = q.eq('status', status.toUpperCase())
  const { data, error } = await q
  if (error) return c.json({ error: 'internal_error' }, 500)
  return c.json({ data, merchant: m.name, limit })
})

publicApiRoutes.get('/stats', async (c) => {
  const { data: m } = await db.from('merchants').select('name').eq('id', c.get('merchantId')).maybeSingle()
  if (!m) return c.json({ error: 'not_found' }, 404)
  const { data, error } = await db.rpc('merchant_status_counts', { p_merchant: m.name })
  if (error) return c.json({ error: 'internal_error', detail: error.message }, 500)
  return c.json({ merchant: m.name, by_status: data ?? [] })
})
