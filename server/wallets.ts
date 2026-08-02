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

walletRoutes.post('/:walletNumber/assignment', requirePerm('wallets', 'can_edit'), async (c) => {
  const walletNumber = decodeURIComponent(c.req.param('walletNumber')).trim()
  const body = await c.req.json<{ device?: string; sim_slot?: number | null; note?: string }>().catch(() => null)
  const device = body?.device?.trim()
  const simSlot = body?.sim_slot == null ? null : Number(body.sim_slot)

  if (!walletNumber || !device || (simSlot != null && (!Number.isInteger(simSlot) || simSlot < 0))) {
    return c.json({ error: 'invalid_assignment' }, 400)
  }

  const { data: targetDevice, error: deviceError } = await db
    .from('device_status')
    .select('device, sim_slot')
    .eq('device', device)
    .eq('sim_slot', simSlot ?? 0)
    .maybeSingle()
  if (deviceError) return c.json({ error: 'db_error', detail: deviceError.message }, 500)
  if (!targetDevice) return c.json({ error: 'unknown_device' }, 404)

  const { data: before, error: beforeError } = await db
    .from('wallet_device_map')
    .select('to_account_number, device, sim_slot')
    .eq('to_account_number', walletNumber)
    .maybeSingle()
  if (beforeError) return c.json({ error: 'db_error', detail: beforeError.message }, 500)
  if (!before) return c.json({ error: 'wallet_not_found' }, 404)

  const { error: updateError } = await db
    .from('wallet_device_map')
    .update({
      device,
      sim_slot: simSlot,
      auto_inferred: false,
      confidence: 100,
      updated_at: new Date().toISOString(),
    })
    .eq('to_account_number', walletNumber)
  if (updateError) return c.json({ error: 'db_error', detail: updateError.message }, 500)

  // Keep the reassignment traceable without failing a completed mapping when
  // optional audit/history tables are unavailable in an older environment.
  await Promise.all([
    db.from('wallet_device_history').insert({
      wallet_number: walletNumber,
      device,
      sim_slot: simSlot,
      changed_by: c.get('user')?.username ?? 'panel',
      note: body?.note?.trim() || `Reassigned from ${before.device ?? 'unassigned'}`,
    }),
    db.from('audit_log').insert({
      actor_type: 'panel_user',
      actor_name: c.get('user')?.username ?? 'panel',
      action: 'wallet_device_reassigned',
      entity: 'wallet_device_map',
      entity_id: walletNumber,
      before: { device: before.device, sim_slot: before.sim_slot },
      after: { device, sim_slot: simSlot },
    }),
  ]).catch(() => {})

  return c.json({ ok: true, wallet: walletNumber, device, sim_slot: simSlot })
})
