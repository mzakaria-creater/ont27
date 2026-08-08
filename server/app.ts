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
app.route('/review', reviewRoutes)
app.route('/telegram', telegramRoutes)
app.route('/', extraRoutes)
