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
app.route('/', extraRoutes)
