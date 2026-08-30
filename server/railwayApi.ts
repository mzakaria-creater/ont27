import { Hono } from 'hono'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

const DEFAULT_BASE_URL = 'https://api.ontarget-egy.com'

function baseUrl() {
  return (process.env.ONTARGET_RAILWAY_API_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
}

type JsonObject = Record<string, unknown>

async function railwayFetch(path: string, authenticated = false) {
  const headers: Record<string, string> = { accept: 'application/json' }
  const apiKey = process.env.ONTARGET_RAILWAY_API_KEY?.trim()
  if (authenticated && apiKey) headers['x-api-key'] = apiKey
  const started = Date.now()
  const response = await fetch(`${baseUrl()}${path}`, {
    headers,
    signal: AbortSignal.timeout(8_000),
  })
  const body = await response.json().catch(() => null) as JsonObject | null
  return { response, body, latencyMs: Date.now() - started }
}

export const railwayApiRoutes = new Hono<AuthEnv>()
railwayApiRoutes.use('*', requireAuth)

railwayApiRoutes.get('/status', async (c) => {
  const apiKeyConfigured = Boolean(process.env.ONTARGET_RAILWAY_API_KEY?.trim())
  try {
    const health = await railwayFetch('/health')
    let protectedAccess: boolean | null = null
    if (apiKeyConfigured) {
      const check = await railwayFetch('/v1/auth/keys/validate', true).catch(() => null)
      protectedAccess = Boolean(check?.response.ok)
    }
    return c.json({
      connected: health.response.ok && health.body?.status === 'ok',
      baseUrl: baseUrl(),
      docsUrl: `${baseUrl()}/docs`,
      version: typeof health.body?.version === 'string' ? health.body.version : null,
      remoteTimestamp: typeof health.body?.timestamp === 'string' ? health.body.timestamp : null,
      latencyMs: health.latencyMs,
      apiKeyConfigured,
      protectedAccess,
    })
  } catch (error) {
    return c.json({
      connected: false,
      baseUrl: baseUrl(),
      docsUrl: `${baseUrl()}/docs`,
      version: null,
      remoteTimestamp: null,
      latencyMs: null,
      apiKeyConfigured,
      protectedAccess: false,
      error: error instanceof Error ? error.message : 'railway_unreachable',
    })
  }
})

railwayApiRoutes.get('/dashboard', async (c) => {
  if (!process.env.ONTARGET_RAILWAY_API_KEY?.trim()) {
    return c.json({ error: 'railway_api_key_not_configured' }, 503)
  }
  const result = await railwayFetch('/v1/stats/dashboard', true).catch(() => null)
  if (!result) return c.json({ error: 'railway_unreachable' }, 502)
  if (!result.response.ok) return c.json({ error: 'railway_request_failed', status: result.response.status }, 502)
  return c.json({ data: result.body, latencyMs: result.latencyMs })
})
