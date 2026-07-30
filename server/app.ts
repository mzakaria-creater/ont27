import { Hono } from 'hono'
import { authRoutes } from './auth.js'
import { payRoutes } from './pay.js'
import { linkRoutes } from './links.js'

export const app = new Hono().basePath('/api')

app.get('/health', (c) => c.json({ ok: true }))
app.route('/auth', authRoutes)
app.route('/pay', payRoutes)
app.route('/links', linkRoutes)
