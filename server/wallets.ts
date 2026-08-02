import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Wallet pool = wallet_device_map (receiving wallets → device/sim), enriched
// with live device_status. Channels = local_deposit_channels (allocation config).

export const walletRoutes = new Hono<AuthEnv>()

walletRoutes.use('*', requireAuth)

walletRoutes.get('/', requirePerm('wallets', 'can_view'), async (c) => {
  // Authoritative live wallet list straight from Maven (checked every few
  // minutes by the old system) — wallet_device_map is only the device
  // mapping and its auto-inferred rows go stale.
  const liveP = (async () => {
    const old = oldDb()
    if (!old) return []
    const { data } = await old.rpc('maven_banks_live_list')
    return Array.isArray(data) ? data : []
  })()

  const [wallets, devices, channels, live] = await Promise.all([
    db
      .from('wallet_device_map')
      .select('to_account_number, device, provider, confidence, auto_inferred, payment_type, daily_limit, merchant, sim_slot, updated_at')
      .order('provider')
      .order('to_account_number'),
    db
      .from('device_status')
      .select('device, sim_slot, sim_number, operator, battery, charging, net_type, online, balance, balance_at, last_seen_at'),
    db
      .from('local_deposit_channels')
      .select('id, channel_type, country_code, currency_code, display_name, active')
      .order('display_name'),
    liveP,
  ])
  if (wallets.error) return c.json({ error: 'db_error', detail: wallets.error.message }, 500)
  if (devices.error) return c.json({ error: 'db_error', detail: devices.error.message }, 500)
  if (channels.error) return c.json({ error: 'db_error', detail: channels.error.message }, 500)
  return c.json({
    live,
    wallets: wallets.data ?? [],
    devices: devices.data ?? [],
    channels: channels.data ?? [],
  })
})
