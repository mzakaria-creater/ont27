import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Binance treasury (§8.5). binance_treasury_config is a SINGLETON by design:
// id is boolean, PK, CHECK (id = true) — exactly one row ever exists. We build
// on that (upsert on id=true), we do NOT "fix" it. No fake data is shown: an
// unconfigured treasury or empty balances surface as explicit empty states.

export const binanceRoutes = new Hono<AuthEnv>()
binanceRoutes.use('*', requireAuth)

const KEYS = ['binance_p2p', 'treasury']
const CFG_COLS = 'id, enabled, asset, network, min_sweep_amount, max_daily_sweep_amount, treasury_wallet_address, config_key, updated_at'

binanceRoutes.get('/', requireAnyPerm(KEYS, 'can_view'), async (c) => {
  const [cfg, bal] = await Promise.all([
    db.from('binance_treasury_config').select(CFG_COLS).eq('id', true).maybeSingle(),
    db.from('binance_account_balances')
      .select('account_id, total_balance, available_balance, usdt_value, btc_value, top_assets, measured_at')
      .order('measured_at', { ascending: false })
      .limit(200),
  ])
  if (cfg.error) return c.json({ error: 'db_error', detail: cfg.error.message }, 500)
  // Latest row per account_id (table is small / usually empty).
  const seen = new Set<string>()
  const latest = (bal.data ?? []).filter((r) => {
    if (seen.has(r.account_id)) return false
    seen.add(r.account_id)
    return true
  })
  const config = cfg.data ?? null
  return c.json({
    config,
    configured: !!(config && config.treasury_wallet_address),
    balances: latest,
  })
})

binanceRoutes.put('/config', requireAnyPerm(KEYS, 'can_edit'), async (c) => {
  const body = await c.req.json().catch(() => null)
  const update: Record<string, unknown> = { id: true, updated_at: new Date().toISOString(), updated_by: c.get('actor').sub }

  if (body?.treasury_wallet_address !== undefined) {
    const addr = typeof body.treasury_wallet_address === 'string' ? body.treasury_wallet_address.trim() : ''
    update.treasury_wallet_address = addr || null
  }
  if (body?.asset !== undefined) {
    const asset = typeof body.asset === 'string' ? body.asset.trim().toUpperCase().slice(0, 12) : ''
    if (!asset) return c.json({ error: 'invalid_asset' }, 400)
    update.asset = asset
  }
  if (body?.network !== undefined) {
    const net = typeof body.network === 'string' ? body.network.trim().toUpperCase().slice(0, 12) : ''
    if (!net) return c.json({ error: 'invalid_network' }, 400)
    update.network = net
  }
  for (const key of ['min_sweep_amount', 'max_daily_sweep_amount'] as const) {
    if (body?.[key] !== undefined) {
      const n = Number(body[key])
      if (!Number.isFinite(n) || n < 0) return c.json({ error: `invalid_${key}` }, 400)
      update[key] = n
    }
  }
  if (body?.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'invalid_enabled' }, 400)
    // Refuse to enable auto-sweep without a destination wallet.
    if (body.enabled) {
      const wallet = update.treasury_wallet_address as string | null | undefined
      if (wallet === null || (wallet === undefined && !(await hasWallet()))) {
        return c.json({ error: 'wallet_required_to_enable' }, 400)
      }
    }
    update.enabled = body.enabled
  }

  const { data, error } = await db.from('binance_treasury_config')
    .upsert(update, { onConflict: 'id' }).select(CFG_COLS).single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 400)
  const actor = c.get('actor')
  await db.from('audit_log').insert({
    actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
    action: 'binance.config_updated', entity: 'binance_treasury_config', entity_id: 'default',
    after: { ...update, updated_by: undefined },
  })
  return c.json({ config: data })
})

async function hasWallet(): Promise<boolean> {
  const { data } = await db.from('binance_treasury_config').select('treasury_wallet_address').eq('id', true).maybeSingle()
  return !!data?.treasury_wallet_address
}
