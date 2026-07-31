import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from '../_lib/supabase.js'
import { hashToken } from '../_lib/crypto.js'
import { parseCookies, REFRESH_COOKIE, clearAuthCookies } from '../_lib/cookies.js'
import { methodGuard, sendJson } from '../_lib/http.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return
  try {
    const raw = parseCookies(req)[REFRESH_COOKIE]
    if (raw) {
      await db()
        .from('panel_refresh_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token_hash', hashToken(raw))
        .is('revoked_at', null)
    }
    clearAuthCookies(res)
    return sendJson(res, 200, { step: 'logged_out' })
  } catch (e) {
    console.error('logout error', e)
    clearAuthCookies(res)
    return sendJson(res, 200, { step: 'logged_out' })
  }
}
