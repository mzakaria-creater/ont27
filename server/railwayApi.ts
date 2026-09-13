import { Hono } from 'hono'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// The v3 API is hosted on Railway. The custom domain remains the preferred
// production route, while the Railway hostname is useful for direct health
// checks and initial setup. Keep all credentials server-side.
const DEFAULT_BASE_URL = 'https://api.ontarget-egy.com'

function baseUrl() {
  return (
    process.env.ONTARGET_RAILWAY_API_URL ||
    process.env.RAILWAY_API_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, '')
}

type JsonObject = Record<string, unknown>

function apiKey() {
  return process.env.ONTARGET_RAILWAY_API_KEY?.trim() || process.env.RAILWAY_API_KEY?.trim() || ''
}

function adminSecret() {
  return process.env.ONTARGET_RAILWAY_ADMIN_SECRET?.trim() || process.env.RAILWAY_ADMIN_SECRET?.trim() || ''
}

async function railwayFetch(path: string, auth: 'none' | 'api_key' | 'admin' = 'none') {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (auth === 'api_key' && apiKey()) headers['x-api-key'] = apiKey()
  if (auth === 'admin' && adminSecret()) headers['x-admin-secret'] = adminSecret()
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
  const apiKeyConfigured = Boolean(apiKey())
  const adminSecretConfigured = Boolean(adminSecret())
  try {
    // v3 documents /v1/health. Keep /health as a compatibility fallback for
    // the older custom-domain gateway during a DNS/service transition.
    let health = await railwayFetch('/v1/health')
    if (!health.response.ok) health = await railwayFetch('/health')
    let protectedAccess: boolean | null = null
    if (apiKeyConfigured) {
      // A harmless authenticated stats request is the v3 API-key smoke test.
      const check = await railwayFetch('/v1/stats', 'api_key').catch(() => null)
      protectedAccess = check ? check.response.ok : false
    }
    let adminAccess: boolean | null = null
    if (adminSecretConfigured) {
      const check = await railwayFetch('/v1/admin/merchants', 'admin').catch(() => null)
      adminAccess = check ? check.response.ok : false
    }
    return c.json({
      connected: health.response.ok && (health.body?.status === 'ok' || health.body?.ok === true || health.body?.success === true),
      baseUrl: baseUrl(),
      docsUrl: process.env.ONTARGET_RAILWAY_DOCS_URL?.trim() || `${baseUrl()}/docs`,
      version: typeof health.body?.version === 'string' ? health.body.version : 'v3',
      remoteTimestamp: typeof health.body?.timestamp === 'string' ? health.body.timestamp : new Date().toISOString(),
      latencyMs: health.latencyMs,
      apiKeyConfigured,
      protectedAccess,
      adminSecretConfigured,
      adminAccess,
    })
  } catch (error) {
    return c.json({
      connected: false,
      baseUrl: baseUrl(),
      docsUrl: process.env.ONTARGET_RAILWAY_DOCS_URL?.trim() || `${baseUrl()}/docs`,
      version: null,
      remoteTimestamp: null,
      latencyMs: null,
      apiKeyConfigured,
      protectedAccess: false,
      adminSecretConfigured,
      adminAccess: false,
      error: error instanceof Error ? error.message : 'railway_unreachable',
    })
  }
})

railwayApiRoutes.get('/dashboard', async (c) => {
  if (!adminSecret() && !apiKey()) {
    return c.json({ error: 'railway_credentials_not_configured' }, 503)
  }
  // Admin dashboard data is the documented v3 endpoint. API-key fallback is
  // retained for deployments that expose only merchant-scoped stats.
  const auth = adminSecret() ? 'admin' : 'api_key'
  const path = adminSecret() ? '/v1/admin/transactions?limit=50' : '/v1/stats'
  const result = await railwayFetch(path, auth).catch(() => null)
  if (!result) return c.json({ error: 'railway_unreachable' }, 502)
  if (!result.response.ok) return c.json({ error: 'railway_request_failed', status: result.response.status }, 502)
  return c.json({ data: result.body, latencyMs: result.latencyMs })
})
