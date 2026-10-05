// Local dev entry: loads .env manually (no dotenv dep), then serves the Hono app.
// Production uses api/[[...path]].ts on Vercel instead.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// .env.development.local is what `vercel env pull` writes by default — the
// real SUPABASE_URL/SUPABASE_SECRET_KEY etc. for this project live there,
// not in .env/.env.local (which this repo keeps empty of secrets). Without
// it, `npm run dev:api` always failed with "Missing SUPABASE_URL /
// SUPABASE_SECRET_KEY (server env)" even though the credentials were right
// there on disk.
const envFiles = ['../.env', '../.env.local', '../.env.development.local']
for (const envFile of envFiles) {
  const envPath = resolve(import.meta.dirname, envFile)
  if (!existsSync(envPath)) continue
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match || process.env[match[1]] !== undefined) continue
    // vercel env pull wraps every value in double quotes; a literal quote
    // character left in, say, SUPABASE_URL breaks every fetch() call that
    // uses it.
    const value = match[2]
    process.env[match[1]] = /^".*"$/.test(value) ? value.slice(1, -1) : value
  }
}

const { serve } = await import('@hono/node-server')
const { app } = await import('./app.js')

const port = Number(process.env.PANEL_API_PORT || 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`panel API → http://localhost:${port}/api/health`)
})
