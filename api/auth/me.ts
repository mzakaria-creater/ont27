import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authenticate } from '../_lib/guard.js'
import { getPermissions } from '../_lib/rbac.js'
import { methodGuard, sendJson } from '../_lib/http.js'

/** Current session identity + this role's full page-permission matrix. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'GET')) return
  try {
    const claims = await authenticate(req)
    if (!claims) return sendJson(res, 401, { error: 'unauthenticated' })
    const permissions = await getPermissions(claims.role)
    return sendJson(res, 200, {
      user: { id: claims.user_id, username: claims.username, role: claims.role },
      permissions,
    })
  } catch (e) {
    console.error('me error', e)
    return sendJson(res, 500, { error: 'server_error' })
  }
}
