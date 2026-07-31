import type { VercelRequest, VercelResponse } from '@vercel/node'
import { parseCookies, REFRESH_COOKIE, clearAuthCookies } from '../_lib/cookies.js'
import { rotateRefresh } from '../_lib/session.js'
import { methodGuard, sendJson } from '../_lib/http.js'

/** Silent refresh: exchange a live refresh cookie for a new access+refresh pair. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return
  try {
    const raw = parseCookies(req)[REFRESH_COOKIE]
    const result = await rotateRefresh(res, raw)
    if (!result.ok) {
      clearAuthCookies(res)
      return sendJson(res, 401, { error: 'refresh_invalid', reason: result.reason })
    }
    return sendJson(res, 200, { step: 'refreshed' })
  } catch (e) {
    console.error('refresh error', e)
    return sendJson(res, 500, { error: 'server_error' })
  }
}
