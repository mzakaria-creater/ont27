import { Hono } from 'hono'
import { authRoutes } from './auth.js'
import { payRoutes } from './pay.js'
import { linkRoutes } from './links.js'
import { depositRoutes } from './deposits.js'
import { payoutRoutes } from './payouts.js'
import { merchantRoutes } from './merchants.js'
import { walletRoutes } from './wallets.js'
import { smsRoutes } from './sms.js'
import { lateSmsMatchRoutes } from './lateSmsMatches.js'
import { deltaSyncRoutes } from './deltaSync.js'
import { extraRoutes } from './extras.js'
import { controlRoutes } from './control.js'
import { complaintRoutes } from './complaints.js'
import { paymentMethodRoutes } from './paymentMethods.js'
import { adminRoutes } from './admin.js'
import { reportsRoutes } from './reports.js'
import { reviewRoutes } from './review.js'
import { telegramRoutes } from './telegram.js'
import { publicApiRoutes } from './publicApi.js'
import { binanceRoutes } from './binance.js'
import { txEditRoutes } from './txEdit.js'
import { performanceRoutes } from './performance.js'
import { monitoringRoutes } from './monitoring.js'
import { replayRoutes } from './replay.js'
import { chatRoutes } from './chat.js'
import { revenueRoutes } from './revenue.js'
import { financeOpsRoutes } from './financeOps.js'
import { webhookRoutes } from './webhooks.js'
import { railwayApiRoutes } from './railwayApi.js'
import { ticketRoutes } from './tickets.js'
import { payoutRequestRoutes } from './payoutRequests.js'
import { payoutLinkRoutes } from './payoutLinks.js'
import { proofExtractRoutes } from './proofExtract.js'
import { transactionsAiRoutes } from './transactionsAi.js'
import { gatewayDashboardRoutes } from './gatewayDashboard.js'
import { deviceRoutes } from './devices.js'
import { gatewayRoutes } from './gateway.js'
import { emailNotificationRoutes } from './emailNotifications.js'
import { whatsappRoutes, whatsappWebhookRoutes } from './whatsapp.js'
import { db } from './db.js'

export const app = new Hono().basePath('/api')

// Readiness, not just process liveness: a warm Vercel function can still be
// unable to serve login or operational data when the Supabase origin is down.
// Keep the probe cheap and bounded so monitoring gets a truthful 503 quickly.
app.get('/health', async (c) => {
  const startedAt = Date.now()
  c.header('Cache-Control', 'no-store')
  try {
    const { error } = await db
      .from('panel_users')
      .select('id')
      .limit(1)
      .abortSignal(AbortSignal.timeout(3_000))
    if (error) throw error
    return c.json({ ok: true, api: true, database: true, latency_ms: Date.now() - startedAt })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('backend health database check failed:', message.replace(/\s+/g, ' ').slice(0, 300))
    c.header('Retry-After', '5')
    return c.json({ ok: false, api: true, database: false, error: 'database_unavailable', latency_ms: Date.now() - startedAt }, 503)
  }
})
app.route('/auth', authRoutes)
app.route('/pay', payRoutes)
app.route('/links', linkRoutes)
app.route('/deposits', depositRoutes)
app.route('/payouts', payoutRoutes)
app.route('/payout-requests', payoutRequestRoutes)
app.route('/payout-links', payoutLinkRoutes)
app.route('/proof', proofExtractRoutes)
app.route('/transactions-ai', transactionsAiRoutes)
app.route('/gateway-dashboard', gatewayDashboardRoutes)
app.route('/devices', deviceRoutes)
app.route('/merchants', merchantRoutes)
app.route('/wallets', walletRoutes)
app.route('/sms', smsRoutes)
app.route('/late-matches', lateSmsMatchRoutes)
app.route('/cron', deltaSyncRoutes)
app.route('/control', controlRoutes)
app.route('/complaints', complaintRoutes)
app.route('/tickets', ticketRoutes)
app.route('/payment-methods', paymentMethodRoutes)
app.route('/admin', adminRoutes)
app.route('/reports', reportsRoutes)
app.route('/performance', performanceRoutes)
app.route('/monitoring', monitoringRoutes)
app.route('/replay', replayRoutes)
app.route('/chat', chatRoutes)
app.route('/review', reviewRoutes)
app.route('/telegram', telegramRoutes)
app.route('/binance', binanceRoutes)
app.route('/revenue', revenueRoutes)
app.route('/finance-ops', financeOpsRoutes)
// Meta verification must be mounted before the authenticated generic webhook
// router, otherwise `/webhooks/*` intercepts this public callback first.
app.route('/webhooks/whatsapp', whatsappWebhookRoutes)
app.route('/webhooks', webhookRoutes)
app.route('/railway', railwayApiRoutes)
app.route('/tx', txEditRoutes)
app.route('/v1', publicApiRoutes)
app.route('/v1/gateway', gatewayRoutes)
app.route('/email-notifications', emailNotificationRoutes)
app.route('/whatsapp', whatsappRoutes)
app.route('/', extraRoutes)
