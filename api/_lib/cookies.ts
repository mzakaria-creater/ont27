import type { VercelRequest, VercelResponse } from '@vercel/node'

export const ACCESS_COOKIE = 'pa_access'
export const REFRESH_COOKIE = 'pa_refresh'

export function parseCookies(req: VercelRequest): Record<string, string> {
  const header = req.headers.cookie
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

interface CookieOpts {
  maxAgeSec?: number
  expired?: boolean
}

// SameSite=Strict is safe here because the SPA and the /api functions are served
// from the same Vercel origin — there is no legitimate cross-site auth flow.
function serialize(name: string, value: string, opts: CookieOpts): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ]
  if (opts.expired) {
    parts.push('Max-Age=0')
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  } else if (opts.maxAgeSec != null) {
    parts.push(`Max-Age=${opts.maxAgeSec}`)
  }
  return parts.join('; ')
}

export function setCookies(
  res: VercelResponse,
  cookies: Array<{ name: string; value: string; maxAgeSec?: number }>,
): void {
  const existing = res.getHeader('Set-Cookie')
  const prior = Array.isArray(existing)
    ? existing
    : existing
      ? [String(existing)]
      : []
  const serialized = cookies.map((c) =>
    serialize(c.name, c.value, { maxAgeSec: c.maxAgeSec }),
  )
  res.setHeader('Set-Cookie', [...prior, ...serialized])
}

export function clearAuthCookies(res: VercelResponse): void {
  res.setHeader('Set-Cookie', [
    serialize(ACCESS_COOKIE, '', { expired: true }),
    serialize(REFRESH_COOKIE, '', { expired: true }),
  ])
}
