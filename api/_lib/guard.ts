import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ACCESS_COOKIE, parseCookies } from './cookies.js'
import { verifyAccess, type AccessClaims } from './jwt.js'
import { authorize, type PermAction } from './rbac.js'
import { sendJson } from './http.js'

/**
 * Verify the access cookie and return the caller's claims, or null if there is
 * no valid session. This is the reusable guard every protected endpoint uses.
 */
export async function authenticate(req: VercelRequest): Promise<AccessClaims | null> {
  const token = parseCookies(req)[ACCESS_COOKIE]
  if (!token) return null
  try {
    return await verifyAccess(token)
  } catch {
    return null
  }
}

/**
 * Guard a handler: 401 if unauthenticated, and (optionally) 403 unless the
 * caller's role holds `action` on `page`. Returns the claims on success so the
 * handler can use them; returns null after having already sent the error.
 */
export async function requireAuth(
  req: VercelRequest,
  res: VercelResponse,
  opts?: { page: string; action: PermAction },
): Promise<AccessClaims | null> {
  const claims = await authenticate(req)
  if (!claims) {
    sendJson(res, 401, { error: 'unauthenticated' })
    return null
  }
  if (opts) {
    const ok = await authorize(claims.role, opts.page, opts.action)
    if (!ok) {
      sendJson(res, 403, { error: 'forbidden', page: opts.page, action: opts.action })
      return null
    }
  }
  return claims
}
