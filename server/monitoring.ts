import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const monitoringRoutes = new Hono<AuthEnv>()
monitoringRoutes.use('*', requireAuth)

monitoringRoutes.get('/market-prices', async (c) => {
  const started = Date.now()
  const p2pBody = (tradeType: 'BUY' | 'SELL') => JSON.stringify({ fiat: 'EGP', page: 1, rows: 10, tradeType, asset: 'USDT', countries: [], proMerchantAds: false, publisherType: null, payTypes: [] })
  const [goldResponse, buyResponse, sellResponse] = await Promise.all([
    fetch('https://api.gold-api.com/price/XAU', { signal: AbortSignal.timeout(4_000) }).catch(() => null),
    fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: p2pBody('BUY'), signal: AbortSignal.timeout(5_000) }).catch(() => null),
    fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: p2pBody('SELL'), signal: AbortSignal.timeout(5_000) }).catch(() => null),
  ])
  const gold: any = goldResponse?.ok ? await goldResponse.json().catch(() => null) : null
  const buy: any = buyResponse?.ok ? await buyResponse.json().catch(() => null) : null
  const sell: any = sellResponse?.ok ? await sellResponse.json().catch(() => null) : null
  const buyPrices = (buy?.data ?? []).map((row: any) => Number(row?.adv?.price)).filter((value: number) => Number.isFinite(value) && value > 0)
  const sellPrices = (sell?.data ?? []).map((row: any) => Number(row?.adv?.price)).filter((value: number) => Number.isFinite(value) && value > 0)
  const usdtBuy = buyPrices.length ? Math.min(...buyPrices) : null
  const usdtSell = sellPrices.length ? Math.max(...sellPrices) : null
  return c.json({
    xauUsd: typeof gold?.price === 'number' ? gold.price : null,
    usdtEgp: usdtBuy != null && usdtSell != null ? (usdtBuy + usdtSell) / 2 : usdtBuy ?? usdtSell,
    usdtBuyEgp: usdtBuy, usdtSellEgp: usdtSell,
    updatedAt: new Date().toISOString(), latencyMs: Date.now() - started,
    sources: { xauUsd: 'gold-api.com', usdtEgp: 'Binance P2P USDT/EGP' },
  })
})

const latest = (values: Array<string | null | undefined>) =>
  values.filter((v): v is string => Boolean(v)).sort().at(-1) ?? null

monitoringRoutes.post('/client-error', async (c) => {
  const body = await c.req.json().catch(() => null)
  const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : null
  const route = text(body?.route, 300) ?? 'unknown'
  const message = text(body?.message, 1000) ?? 'unknown_client_error'
  const after = {
    route,
    message,
    stack: text(body?.stack, 4000),
    component_stack: text(body?.component_stack, 4000),
    user_agent: text(body?.user_agent, 500),
    build_asset: text(body?.build_asset, 300),
  }
  const actor = c.get('actor')
  console.error('[client-render-error]', { actor: actor.username, route, message, stack: after.stack })
  const { error } = await db.from('audit_log').insert({
    actor_type: 'panel_client', actor_id: actor.sub, actor_name: actor.username,
    action: 'client.render_error', entity: 'route', entity_id: route, after,
  })
  return c.json({ ok: !error }, error ? 500 : 200)
})

monitoringRoutes.get('/', async (c) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const deviceDb = oldDb() ?? db
  const started = Date.now()

  const [sms, transactions, telegram, devices, integrations, pendingDeposits, pendingPayouts, editRequests, todayTransactions] = await Promise.all([
    db.from('inbound_sms')
      .select('id, received_at, device_name, sender_name, sender_number, receiver_number, amount, sms_category, trx_id, consumed_by_tx_id, matched_transaction_id, maven_transaction_id')
      .gte('received_at', since).order('received_at', { ascending: false }).limit(30),
    db.from('maven_transactions')
      .select('tx_id, ontarget_ref, status, amount, currency, sender_name, merchant, master_merchant, gateway, first_seen_at, last_status_change')
      .gte('first_seen_at', since).order('first_seen_at', { ascending: false }).limit(30),
    db.from('telegram_alerts')
      .select('id, alert_type, chat_id, ok, error, created_at')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(30),
    deviceDb.from('device_status')
      .select('device, sim_slot, online, battery, charging, net_type, last_seen_at')
      .order('device'),
    db.from('audit_log')
      .select('id, action, entity, entity_id, actor_name, after, created_at')
      .or('action.ilike.%gmail%,action.ilike.%email%,action.ilike.%webhook%,entity.ilike.%webhook%')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(30),
    db.from('maven_transactions').select('tx_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    db.from('maven_payout_transactions').select('maven_id', { count: 'exact', head: true }).eq('status', 'PENDING'),
    db.from('transaction_edit_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    db.from('maven_transactions').select('status, amount').gte('first_seen_at', todayStart.toISOString()).limit(10000),
  ])

  const sources = {
    sms: { ok: !sms.error, error: sms.error?.message ?? null },
    transactions: { ok: !transactions.error, error: transactions.error?.message ?? null },
    telegram: { ok: !telegram.error, error: telegram.error?.message ?? null },
    devices: { ok: !devices.error, error: devices.error?.message ?? null },
    integrations: { ok: !integrations.error, error: integrations.error?.message ?? null },
    queues: { ok: !pendingDeposits.error && !pendingPayouts.error && !editRequests.error,
      error: pendingDeposits.error?.message ?? pendingPayouts.error?.message ?? editRequests.error?.message ?? null },
  }
  const smsRows = sms.data ?? []
  const txRows = transactions.data ?? []
  const telegramRows = telegram.data ?? []
  const deviceRows = devices.data ?? []
  const integrationRows = integrations.data ?? []
  const todayRows = todayTransactions.data ?? []
  const todaySummary = todayRows.reduce((summary, row) => {
    summary.total += 1
    summary.amount += Number(row.amount ?? 0)
    if (['PAID', 'APPROVED'].includes(row.status)) { summary.approved += 1; summary.paidAmount += Number(row.amount ?? 0) }
    else if (['DECLINED', 'FAILED'].includes(row.status)) summary.rejected += 1
    else if (row.status === 'PENDING') summary.processing += 1
    return summary
  }, { total: 0, amount: 0, paidAmount: 0, approved: 0, rejected: 0, processing: 0 })
  const providerSummary = (name: 'nagopay' | 'payfuture') => {
    const rows = txRows.filter((row) => {
      const identity = `${row.gateway ?? ''} ${row.master_merchant ?? ''}`.toLowerCase()
      return name === 'nagopay'
        ? identity.includes('nagupay') || identity.includes('ngpay')
        : identity.includes('payfuture') || identity.includes('avadapay') || /(^|\s)rsc($|\s)/.test(identity)
    })
    return { count24h: rows.length, pending: rows.filter((row) => row.status === 'PENDING').length,
      lastChange: latest(rows.map((row) => row.last_status_change ?? row.first_seen_at)) }
  }

  return c.json({
    generatedAt: new Date().toISOString(),
    api: { ok: true, latencyMs: Date.now() - started },
    supabase: {
      ok: Object.entries(sources).filter(([name]) => name !== 'devices').every(([, source]) => source.ok),
      latencyMs: Date.now() - started,
      failedSources: Object.entries(sources).filter(([, source]) => !source.ok).map(([name]) => name),
    },
    queues: {
      pendingDeposits: pendingDeposits.count ?? null,
      pendingPayouts: pendingPayouts.count ?? null,
      editRequests: editRequests.count ?? null,
    },
    todaySummary,
    providers: { nagopay: providerSummary('nagopay'), payfuture: providerSummary('payfuture') },
    lastSync: latest([
      ...smsRows.map((r) => r.received_at),
      ...txRows.map((r) => r.last_status_change ?? r.first_seen_at),
      ...telegramRows.map((r) => r.created_at),
      ...deviceRows.map((r) => r.last_seen_at),
      ...integrationRows.map((r) => r.created_at),
    ]),
    sources,
    sms: smsRows.map((r) => ({
      ...r,
      assigned_tx_id: r.consumed_by_tx_id ?? r.matched_transaction_id ?? r.maven_transaction_id ?? null,
    })),
    transactions: txRows,
    telegram: telegramRows,
    email: integrationRows.filter((r) => /gmail|email/i.test(`${r.action} ${r.entity}`)),
    webhooks: integrationRows.filter((r) => /webhook/i.test(`${r.action} ${r.entity}`)),
    devices: deviceRows,
  })
})
