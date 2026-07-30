// Local dev entry: loads .env manually (no dotenv dep), then serves the Hono app.
// Production uses api/[[...path]].ts on Vercel instead.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

for (const line of readFileSync(resolve(import.meta.dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
}

const { serve } = await import('@hono/node-server')
const { app } = await import('./app.js')

const port = Number(process.env.PANEL_API_PORT || 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`panel API → http://localhost:${port}/api/health`)
})
