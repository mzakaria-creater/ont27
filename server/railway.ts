// Railway production entry: one Node process serving the built SPA (dist/)
// and the Hono API. Env comes from Railway service variables (no .env file).
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { app as api } from './app.js'

const root = new Hono()
root.route('/', api) // owns /api/*
root.use('/*', serveStatic({ root: './dist' }))
root.use('*', serveStatic({ path: './dist/index.html' })) // SPA fallback

const port = Number(process.env.PORT || 8080)
serve({ fetch: root.fetch, port }, () => {
  console.log(`ont27 panel → :${port}`)
})
