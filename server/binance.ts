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

async function binanceTime(): Promise<number> {
  const response = await fetch('https://api.binance.com/api/v3/time', { signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error(`time_http_${response.status}`)
  const body = await response.json() as { serverTime?: number }
  if (!Number.isFinite(body.serverTime)) throw new Error('invalid_server_time')
  return Number(body.serverTime)
}

async function signedC2cHistory(creds: { api_key: string; api_secret: string }, side: 'BUY' | 'SELL', page = 1, rows = 50, range?: { startTimestamp?: number; endTimestamp?: number }) {
  const timestamp = await binanceTime()
  const params = new URLSearchParams({ tradeType: side, page: String(page), rows: String(rows), recvWindow: '5000', timestamp: String(timestamp) })
  if (range?.startTimestamp) params.set('startTimestamp', String(range.startTimestamp))
  if (range?.endTimestamp) params.set('endTimestamp', String(range.endTimestamp))
  params.set('signature', createHmac('sha256', creds.api_secret).update(params.toString()).digest('hex'))
  return fetch(`https://api.binance.com/sapi/v1/c2c/orderMatch/listUserOrderHistory?${params}`, {
    headers: { 'X-MBX-APIKEY': creds.api_key }, signal: AbortSignal.timeout(10_000),
  })
}

async function signedSpotAccount(creds: { api_key: string; api_secret: string }) {
  const timestamp = await binanceTime()
  const params = new URLSearchParams({ recvWindow: '5000', timestamp: String(timestamp) })
  params.set('signature', createHmac('sha256', creds.api_secret).update(params.toString()).digest('hex'))
  return fetch(`https://api.binance.com/api/v3/account?${params}`, {
    headers: { 'X-MBX-APIKEY': creds.api_key }, signal: AbortSignal.timeout(10_000),
  })
}

async function signedFundingBalances(creds: { api_key: string; api_secret: string }) {
  const timestamp = await binanceTime()
  const params = new URLSearchParams({ recvWindow: '5000', timestamp: String(timestamp) })
  params.set('signature', createHmac('sha256', creds.api_secret).update(params.toString()).digest('hex'))
  return fetch('https://api.binance.com/sapi/v1/asset/get-funding-asset', {
    method: 'POST', headers: { 'X-MBX-APIKEY': creds.api_key, 'content-type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(10_000),
  })
}

function normalizeC2cOrder(row: Record<string, unknown>, side: 'BUY' | 'SELL') {
  const methods = Array.isArray(row.payMethods) ? row.payMethods : []
  const payMethodNames = methods.map((method) => {
    if (method && typeof method === 'object') {
      const value = method as Record<string, unknown>
      return String(value.payType ?? value.identifier ?? value.name ?? '').trim()
    }
    return String(method ?? '').trim()
  }).filter(Boolean)
  return {
    orderNumber: row.orderNumber ?? null,
    advNo: row.advNo ?? null,
    tradeType: row.tradeType ?? side,
    asset: row.asset ?? 'USDT',
    fiat: row.fiat ?? 'EGP',
    amount: row.amount ?? null,
    totalPrice: row.totalPrice ?? null,
    unitPrice: row.unitPrice ?? null,
    orderStatus: row.orderStatus ?? null,
    createTime: row.createTime ?? null,
    commission: row.commission ?? null,
    trader: row.counterPartNickName ?? row.counterpartyNickName ?? row.buyerNickname ?? row.sellerNickname ?? row.nickName ?? null,
    paymentMethods: payMethodNames,
    paymentMethod: payMethodNames[0] ?? null,
  }
}

binanceRoutes.get('/market', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const requested = (c.req.query('symbols') ?? 'BTCUSDT,ETHUSDT,BNBUSDT')
    .split(',').map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => /^[A-Z0-9]{5,20}$/.test(symbol)).slice(0, 10)
  if (!requested.length) return c.json({ error: 'invalid_symbols' }, 400)
  const query = new URLSearchParams({ symbols: JSON.stringify(requested) })
  const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?${query}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null)
  if (!response) return c.json({ error: 'binance_unreachable' }, 502)
  const result = await response.json().catch(() => ({ msg: 'invalid_response' }))
  if (!response.ok) return c.json({ error: 'binance_error', provider_status: response.status, provider: result }, 502)
  return c.json({ prices: result, source: 'Binance Spot public market data', at: new Date().toISOString() })
})

// A lightweight, account-authorized health check. It never returns credentials
// or provider payloads; it only confirms whether a signed C2C read succeeds.
binanceRoutes.get('/health', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const creds = await credentials()
  if (!creds) return c.json({ connected: false, reason: 'credentials_required', checked_at: new Date().toISOString() })
  try {
    const response = await signedC2cHistory(creds, 'BUY', 1, 1)
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    return c.json({ connected: response.ok, reason: response.ok ? null : 'provider_rejected_request', provider_status: response.status, code: result.code ?? null, checked_at: new Date().toISOString() })
  } catch (error) {
    return c.json({ connected: false, reason: 'binance_unreachable', detail: error instanceof Error ? error.message : 'request_failed', checked_at: new Date().toISOString() }, 502)
  }
})

binanceRoutes.get('/wallet', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const creds = await credentials()
  if (!creds) return c.json({ error: 'credentials_required' }, 409)
  try {
    const spotResponse = await signedSpotAccount(creds)
    const spotResult = await spotResponse.json().catch(() => ({ msg: 'invalid_response' })) as Record<string, unknown>
    let balances = Array.isArray(spotResult.balances) ? spotResult.balances.map((row) => {
      const value = row as Record<string, unknown>
      return { asset: String(value.asset ?? ''), free: String(value.free ?? '0'), locked: String(value.locked ?? '0') }
    }).filter((row) => Number(row.free) > 0 || Number(row.locked) > 0) : []
    const fundingResponse = await signedFundingBalances(creds).catch(() => null)
    const fundingResult = fundingResponse ? await fundingResponse.json().catch(() => ({ msg: 'invalid_response' })) : []
    const fundingBalances = fundingResponse?.ok && Array.isArray(fundingResult) ? fundingResult.map((row) => { const value = row as Record<string, unknown>; return { asset: String(value.asset ?? ''), free: String(value.free ?? value.amount ?? '0'), locked: String(value.freeze ?? value.locked ?? '0') } }).filter((row) => Number(row.free) > 0 || Number(row.locked) > 0) : []
    if (!spotResponse.ok && !fundingResponse?.ok) {
      return c.json({ error: 'binance_error', provider_status: fundingResponse?.status ?? spotResponse.status, code: (fundingResult as Record<string, unknown>).code ?? spotResult.code ?? null, message: (fundingResult as Record<string, unknown>).msg ?? spotResult.msg ?? null }, 502)
    }
    const byAsset = new Map<string, { asset: string; free: number; locked: number }>()
    for (const row of [...balances, ...fundingBalances]) {
      const current = byAsset.get(row.asset) ?? { asset: row.asset, free: 0, locked: 0 }
      current.free += Number(row.free) || 0; current.locked += Number(row.locked) || 0
      byAsset.set(row.asset, current)
    }
    return c.json({ balances: [...byAsset.values()].map((row) => ({ asset: row.asset, free: String(row.free), locked: String(row.locked) })), source: spotResponse.ok && fundingResponse?.ok ? 'spot+funding' : spotResponse.ok ? 'spot' : 'funding', accountType: spotResult.accountType ?? null, canTrade: spotResult.canTrade ?? null, at: new Date().toISOString() })
  } catch (error) {
    return c.json({ error: 'binance_unreachable', detail: error instanceof Error ? error.message : 'request_failed' }, 502)
  }
})

binanceRoutes.get('/connection', requireSuperAdmin, async (c) => {
  const creds = await credentials()
  if (!creds) return c.json({ error: 'credentials_required' }, 409)
  try {
    const response = await signedC2cHistory(creds, 'BUY', 1, 1)
    const result = await response.json().catch(() => ({ msg: 'invalid_response' })) as Record<string, unknown>
    const actor = c.get('actor')
    await db.from('audit_log').insert({ actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username, action: response.ok ? 'binance.api_connection_succeeded' : 'binance.api_connection_failed', entity: 'binance_api', entity_id: 'c2c', after: { provider_status: response.status, code: result.code ?? null } })
    if (!response.ok) return c.json({ error: 'binance_error', provider_status: response.status, code: result.code ?? null, message: result.msg ?? null }, 502)
    return c.json({ ok: true, permission: 'C2C_USER_DATA', checked_at: new Date().toISOString() })
  } catch (error) {
    return c.json({ error: 'binance_unreachable', detail: error instanceof Error ? error.message : 'request_failed' }, 502)
  }
})

binanceRoutes.get('/history', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const creds = await credentials()
  if (!creds) return c.json({ error: 'credentials_required' }, 409)
  const side = c.req.query('side') === 'SELL' ? 'SELL' : 'BUY'
  const page = Math.min(Math.max(Number(c.req.query('page')) || 1, 1), 1000)
  const rows = Math.min(Math.max(Number(c.req.query('rows')) || 50, 1), 100)
  const response = await signedC2cHistory(creds, side, page, rows, { startTimestamp: Number(c.req.query('from')) || undefined, endTimestamp: Number(c.req.query('to')) || undefined }).catch(() => null)
  if (!response) return c.json({ error: 'binance_unreachable' }, 502)
  const result = await response.json().catch(() => ({ message: 'invalid_response' }))
  if (!response.ok) return c.json({ error: 'binance_error', provider_status: response.status, provider: result }, 502)
  return c.json(result)
})

binanceRoutes.get('/p2p-report', requireAnyPerm(VIEW_KEYS, 'can_view'), async (c) => {
  const creds = await credentials()
  if (!creds) return c.json({ error: 'credentials_required' }, 409)
  const rows = Math.min(Math.max(Number(c.req.query('rows')) || 100, 1), 100)
  const from = Number(c.req.query('from')) || undefined
  const to = Number(c.req.query('to')) || undefined
  const trader = (c.req.query('trader') ?? '').trim().toLowerCase()
  const method = (c.req.query('method') ?? '').trim().toLowerCase()
  const responses = await Promise.all((['BUY', 'SELL'] as const).map((side) => signedC2cHistory(creds, side, 1, rows, { startTimestamp: from, endTimestamp: to }).catch(() => null)))
  const parsed = await Promise.all(responses.map(async (response, index) => {
    if (!response) return []
    const result = await response.json().catch(() => ({ data: [] })) as Record<string, unknown>
    if (!response.ok) return []
    const data = Array.isArray(result.data) ? result.data : []
    return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map((row) => normalizeC2cOrder(row, index === 0 ? 'BUY' : 'SELL'))
  }))
  const filtered = parsed.flat().filter((row) => {
    const traderMatch = !trader || String(row.trader ?? '').toLowerCase().includes(trader)
    const methods = row.paymentMethods.map((value) => value.toLowerCase())
    const methodMatch = !method || methods.some((value) => value.includes(method))
    return (!row.fiat || String(row.fiat).toUpperCase() === 'EGP') && traderMatch && methodMatch
  })
  const byTrader = new Map<string, { trader: string; orders: number; totalEgp: number; buyEgp: number; sellEgp: number }>()
  for (const row of filtered) {
    const name = String(row.trader ?? 'Unknown trader')
    const current = byTrader.get(name) ?? { trader: name, orders: 0, totalEgp: 0, buyEgp: 0, sellEgp: 0 }
    const total = Number(row.totalPrice ?? 0)
    current.orders += 1; current.totalEgp += total
    if (row.tradeType === 'SELL') current.sellEgp += total; else current.buyEgp += total
    byTrader.set(name, current)
  }
  return c.json({ orders: filtered, traders: [...byTrader.values()].sort((a, b) => b.totalEgp - a.totalEgp), from: from ?? null, to: to ?? null, at: new Date().toISOString() })
})

// Human-confirmation audit. Provider payloads are deliberately not returned
// here because they can contain counterparty details; the operational view
// exposes only the result fields needed to reconcile a decision.
binanceRoutes.get('/executions', requireSuperAdmin, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
  const { data, error } = await db.from('binance_p2p_execution_log')
    .select('id, idempotency_key, actor_name, side, asset, fiat, fiat_amount, advertisement_number, confirmed_at, status, provider_order_number, provider_http_status, failure_code, created_at')
    .order('created_at', { ascending: false }).limit(limit)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [] })
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
