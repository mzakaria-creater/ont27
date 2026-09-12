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
  accountId?: string
  paymentMethodId?: string
  paymentMethodCode?: string
  paymentMethodName?: string
  allocations?: Array<{ walletNumber: string; amount: number; provider: string; device: string; accountId?: string }>
}

export interface AllocationOptions {
  poolId?: string | null
  methodCodes?: string[]
  amount?: number
  mode?: 'single_queue' | 'multi_wallet'
  multiWalletThreshold?: number | null
}

// Picks a receiving wallet for a new checkout session, provider-agnostically:
// active channel for the currency → its devices → online device wallets →
// fewest open pending sessions wins (round-robin-ish load spread).
export async function allocateWallet(currency: string, options: AllocationOptions = {}): Promise<AllocatedWallet | null> {
  // Payment-link routing is deliberately resolved before the legacy channel
  // allocator. This keeps old links working while allowing a merchant to pin
  // new links to a pool and a selected set of methods.
  if (options.poolId || (options.methodCodes && options.methodCodes.length)) {
    let accountsQuery = db
      .from('payment_accounts')
      .select('id, payment_method_id, account_number, device_name, label, current_balance, payment_methods!inner(method_code, method_name, channel_type)')
      .eq('is_active', true)
      .eq('currency', currency)
    if (options.poolId) accountsQuery = accountsQuery.eq('payment_pool_id', options.poolId)
    const { data: accounts } = await accountsQuery
    const codes = new Set((options.methodCodes ?? []).map((code) => code.toUpperCase()))
    const candidates = (accounts ?? []).filter((account) => {
      const method = Array.isArray(account.payment_methods) ? account.payment_methods[0] : account.payment_methods
      return !codes.size || codes.has(String(method?.method_code ?? '').toUpperCase())
    })
    if (candidates.length) {
      const { data: open } = await db.from('checkout_sessions').select('metadata').eq('status', 'pending').gt('expires_at', new Date().toISOString())
      const load = new Map<string, number>()
      for (const session of open ?? []) {
        const number = (session.metadata as { wallet_number?: string } | null)?.wallet_number
        if (number) load.set(number, (load.get(number) ?? 0) + 1)
      }
      candidates.sort((a, b) => (load.get(a.account_number) ?? 0) - (load.get(b.account_number) ?? 0))
      const amount = Number(options.amount) || 0
      const multi = options.mode === 'multi_wallet' && amount > 0 && amount >= Number(options.multiWalletThreshold || 0) && candidates.length > 1
      const selected = multi ? candidates.slice(0, Math.min(3, candidates.length)) : candidates.slice(0, 1)
      const first = selected[0]
      const firstMethod = Array.isArray(first.payment_methods) ? first.payment_methods[0] : first.payment_methods
      const allocations = selected.map((account) => ({
        walletNumber: account.account_number,
        amount: Math.round((amount / selected.length) * 100) / 100,
        provider: String((Array.isArray(account.payment_methods) ? account.payment_methods[0] : account.payment_methods)?.method_code ?? 'wallet'),
        device: account.device_name ?? account.label ?? 'payment-account',
        accountId: account.id,
      }))
      return {
        channelId: '',
        channelName: firstMethod?.method_name ?? 'Payment account',
        channelType: firstMethod?.channel_type ?? 'payment_account',
        currency,
        walletNumber: first.account_number,
        provider: String(firstMethod?.method_code ?? 'wallet'),
        device: first.device_name ?? first.label ?? 'payment-account',
        deeplinkTemplate: null,
        accountId: first.id,
        paymentMethodId: first.payment_method_id,
        paymentMethodCode: firstMethod?.method_code,
        paymentMethodName: firstMethod?.method_name,
        allocations: multi ? allocations : undefined,
      }
    }
    // An explicit routing rule must never silently fall back to another
    // merchant's/default wallet. Returning unavailable is safer and makes a
    // misconfigured merchant link visible immediately.
    return null
  }

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
