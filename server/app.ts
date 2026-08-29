import { Hono } from 'hono'
import { authRoutes } from './auth.js'
import { payRoutes } from './pay.js'
import { linkRoutes } from './links.js'
import { depositRoutes } from './deposits.js'
import { payoutRoutes } from './payouts.js'
import { merchantRoutes } from './merchants.js'
import { walletRoutes } from './wallets.js'
import { smsRoutes } from './sms.js'
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

export const app = new Hono().basePath('/api')

app.get('/health', (c) => c.json({ ok: true }))
app.route('/auth', authRoutes)
app.route('/pay', payRoutes)
app.route('/links', linkRoutes)
app.route('/deposits', depositRoutes)
app.route('/payouts', payoutRoutes)
app.route('/merchants', merchantRoutes)
app.route('/wallets', walletRoutes)
app.route('/sms', smsRoutes)
app.route('/cron', deltaSyncRoutes)
app.route('/control', controlRoutes)
app.route('/complaints', complaintRoutes)
// These routes intentionally precede the legacy aggregate endpoints in
// extras.ts: they are the authenticated CRUD surfaces for the new neutral
// payment catalogue and operational administration.
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
// Transaction status/amount edits + the operator request queue behind them.
app.route('/tx', txEditRoutes)
app.route('/v1', publicApiRoutes)
app.route('/', extraRoutes)
