// Local dev entry: loads .env manually (no dotenv dep), then serves the Hono app.
// Production uses api/[[...path]].ts on Vercel instead.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const envFiles = ['../.env', '../.env.local']
for (const envFile of envFiles) {
  const envPath = resolve(import.meta.dirname, envFile)
  if (!existsSync(envPath)) continue
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
  }
}

const { serve } = await import('@hono/node-server')
const { app } = await import('./app.js')

const port = Number(process.env.PANEL_API_PORT || 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`panel API → http://localhost:${port}/api/health`)
})
