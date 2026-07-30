import { db } from './db.js'

export interface AllocatedWallet {
  channelId: string
  channelName: string
  channelType: string
  currency: string
  walletNumber: string
  provider: string
  device: string
  deeplinkTemplate: string | null
}

// Picks a receiving wallet for a new checkout session, provider-agnostically:
// active channel for the currency → its devices → online device wallets →
// fewest open pending sessions wins (round-robin-ish load spread).
export async function allocateWallet(currency: string): Promise<AllocatedWallet | null> {
  const { data: channel } = await db
    .from('local_deposit_channels')
    .select('id, display_name, channel_type, currency_code, config')
    .eq('active', true)
    .eq('currency_code', currency)
    .limit(1)
    .maybeSingle()
  if (!channel) return null

  const cfg = (channel.config ?? {}) as { devices?: string[]; deeplink_template?: string }
  const devices: string[] = cfg.devices ?? []
  if (!devices.length) return null

  const [{ data: wallets }, { data: statuses }, { data: open }] = await Promise.all([
    db.from('wallet_device_map')
      .select('to_account_number, device, provider, daily_limit')
      .in('device', devices),
    db.from('device_status').select('device, online, last_seen_at').in('device', devices),
    db.from('checkout_sessions')
      .select('metadata')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString()),
  ])
  if (!wallets?.length) return null

  const onlineDevices = new Set((statuses ?? []).filter((s) => s.online).map((s) => s.device))
  const load = new Map<string, number>()
  for (const s of open ?? []) {
    const num = (s.metadata as { wallet_number?: string } | null)?.wallet_number
    if (num) load.set(num, (load.get(num) ?? 0) + 1)
  }

  const candidates = wallets
    .filter((w) => onlineDevices.size === 0 || onlineDevices.has(w.device))
    .sort((a, b) => (load.get(a.to_account_number) ?? 0) - (load.get(b.to_account_number) ?? 0))
  const pick = candidates[0] ?? wallets[0]

  return {
    channelId: channel.id,
    channelName: channel.display_name,
    channelType: channel.channel_type,
    currency: channel.currency_code,
    walletNumber: pick.to_account_number,
    provider: pick.provider,
    device: pick.device,
    deeplinkTemplate: cfg.deeplink_template ?? null,
  }
}
