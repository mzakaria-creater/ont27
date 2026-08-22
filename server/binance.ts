import { createHmac, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm, requireSuperAdmin } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const binanceRoutes = new Hono<AuthEnv>()
binanceRoutes.use('*', requireAuth)
const VIEW_KEYS = ['binance_p2p', 'treasury']
const CFG_COLS = 'id, p2p_enabled, p2p_asset, p2p_fiat, max_p2p_order_amount, max_p2p_24h_amount, api_key_secret_id, api_secret_secret_id, updated_at'

function publicConfig(row: Record<string, unknown> | null) {
  if (!row) return null
  const { api_key_secret_id, api_secret_secret_id, ...safe } = row
  return { ...safe, has_credentials: !!api_key_secret_id && !!api_secret_secret_id }
}

binanceRoutes.get('/', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const { data, error } = await db.from('binance_treasury_config').select(CFG_COLS).eq('id', true).maybeSingle()
  if (error) return c.json({ error: error.message.includes('p2p_') ? 'migration_required' : 'db_error' }, error.message.includes('p2p_') ? 503 : 500)
  return c.json({ config: publicConfig(data), execution_capability: 'unavailable', execution_reason: 'No documented Binance P2P order-placement API is configured.' })
})

binanceRoutes.put('/config', requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400)
  const update: Record<string, unknown> = { id: true, updated_at: new Date().toISOString(), updated_by: c.get('actor').sub }
  for (const key of ['max_p2p_order_amount', 'max_p2p_24h_amount'] as const) {
    if (body[key] !== undefined) {
      const n = Number(body[key])
      if (!Number.isFinite(n) || n <= 0) return c.json({ error: `invalid_${key}` }, 400)
      update[key] = n
    }
  }
  if (body.p2p_enabled !== undefined) {
    if (typeof body.p2p_enabled !== 'boolean') return c.json({ error: 'invalid_p2p_enabled' }, 400)
    if (body.p2p_enabled) {
      const { data: current } = await db.from('binance_treasury_config').select(CFG_COLS).eq('id', true).maybeSingle()
      const merged = { ...current, ...update }
      if (!merged.api_key_secret_id || !merged.api_secret_secret_id) return c.json({ error: 'credentials_required' }, 400)
      if (!Number(merged.max_p2p_order_amount) || !Number(merged.max_p2p_24h_amount)) return c.json({ error: 'limits_required' }, 400)
    }
    update.p2p_enabled = body.p2p_enabled
  }
  const { data, error } = await db.from('binance_treasury_config').upsert(update, { onConflict: 'id' }).select(CFG_COLS).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'binance.p2p_config_updated', entity: 'binance_treasury_config', entity_id: 'default', after: { p2p_enabled: data.p2p_enabled, max_p2p_order_amount: data.max_p2p_order_amount, max_p2p_24h_amount: data.max_p2p_24h_amount } })
  return c.json({ config: publicConfig(data) })
})

binanceRoutes.put('/credentials', requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => null)
  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
  const apiSecret = typeof body?.api_secret === 'string' ? body.api_secret.trim() : ''
  if (apiKey.length < 16 || apiSecret.length < 16) return c.json({ error: 'invalid_credentials' }, 400)
  const { error } = await db.rpc('set_binance_p2p_credentials', { p_api_key: apiKey, p_api_secret: apiSecret })
  if (error) return c.json({ error: 'vault_error', detail: error.message }, 500)
  const actor = c.get('actor')
  await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: 'binance.p2p_credentials_replaced', entity: 'binance_treasury_config', entity_id: 'default', after: { has_credentials: true, p2p_enabled: false } })
  return c.json({ ok: true, has_credentials: true, p2p_enabled: false })
})

async function credentials(): Promise<{ api_key: string; api_secret: string } | null> {
  const { data, error } = await db.rpc('get_binance_p2p_credentials')
  if (error || !data?.[0]) return null
  return data[0] as { api_key: string; api_secret: string }
}

binanceRoutes.get('/history', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const creds = await credentials()
  if (!creds) return c.json({ error: 'credentials_required' }, 409)
  const side = c.req.query('side') === 'SELL' ? 'SELL' : 'BUY'
  const params = new URLSearchParams({ tradeType: side, page: '1', rows: '50', recvWindow: '5000', timestamp: String(Date.now()) })
  params.set('signature', createHmac('sha256', creds.api_secret).update(params.toString()).digest('hex'))
  const response = await fetch(`https://api.binance.com/sapi/v1/c2c/orderMatch/listUserOrderHistory?${params}`, { headers: { 'X-MBX-APIKEY': creds.api_key }, signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!response) return c.json({ error: 'binance_unreachable' }, 502)
  const result = await response.json().catch(() => ({ message: 'invalid_response' }))
  if (!response.ok) return c.json({ error: 'binance_error', provider_status: response.status, provider: result }, 502)
  return c.json(result)
})

binanceRoutes.post('/execute', requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => null)
  const amount = Number(body?.fiat_amount)
  const side = body?.side === 'SELL' ? 'SELL' : body?.side === 'BUY' ? 'BUY' : null
  const confirmation = typeof body?.confirmation === 'string' ? body.confirmation : ''
  const idempotencyKey = typeof body?.idempotency_key === 'string' ? body.idempotency_key : randomUUID()
  if (!side || !Number.isFinite(amount) || amount <= 0) return c.json({ error: 'invalid_order' }, 400)
  if (confirmation !== 'CONFIRM BINANCE P2P') return c.json({ error: 'explicit_confirmation_required' }, 400)
  const { data: cfg, error } = await db.from('binance_treasury_config').select(CFG_COLS).eq('id', true).maybeSingle()
  if (error || !cfg) return c.json({ error: 'configuration_unavailable' }, 503)
  if (!cfg.p2p_enabled) return c.json({ error: 'integration_disabled' }, 409)
  if (amount > Number(cfg.max_p2p_order_amount)) return c.json({ error: 'per_order_limit_exceeded', limit: cfg.max_p2p_order_amount }, 422)
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const { data: recent } = await db.from('binance_p2p_execution_log').select('fiat_amount').eq('status', 'SUCCEEDED').gte('confirmed_at', since)
  const used = (recent ?? []).reduce((sum, row) => sum + Number(row.fiat_amount), 0)
  if (used + amount > Number(cfg.max_p2p_24h_amount)) return c.json({ error: 'rolling_24h_limit_exceeded', limit: cfg.max_p2p_24h_amount, used }, 422)
  const actor = c.get('actor')
  const { error: auditError } = await db.from('binance_p2p_execution_log').insert({ idempotency_key: idempotencyKey, actor_id: actor.sub, actor_name: actor.username, side, asset: cfg.p2p_asset, fiat: cfg.p2p_fiat, fiat_amount: amount, advertisement_number: typeof body?.advertisement_number === 'string' ? body.advertisement_number : null, confirmation_text: confirmation, confirmed_at: new Date().toISOString(), status: 'UNAVAILABLE', failure_code: 'DOCUMENTED_PROVIDER_EXECUTION_API_UNAVAILABLE' })
  return c.json({ error: 'provider_execution_unavailable', audited: !auditError }, 501)
})
