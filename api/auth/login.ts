import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db, type PanelUser } from '../_lib/supabase.js'
import { env } from '../_lib/env.js'
import { verifyPassword } from '../_lib/crypto.js'
import { issueSession } from '../_lib/session.js'
import { INVALID_CREDENTIALS, methodGuard, readJsonBody, sendJson } from '../_lib/http.js'

// 2FA is currently NOT enforced at login (explicit product decision, 2026-07-30).
// The panel_users_2fa table, /api/auth/2fa-setup, and /api/auth/2fa-enable stay
// in place so 2FA can be turned back on for can_approve roles later without a
// schema or API redesign — see docs/AUTH.md.

async function registerFailure(user: PanelUser): Promise<boolean> {
  const next = (user.failed_login_count ?? 0) + 1
  const locking = next >= env.maxFailedLogins
  await db()
    .from('panel_users')
    .update({
      failed_login_count: next,
      locked_until: locking
        ? new Date(Date.now() + env.lockMinutes * 60_000).toISOString()
        : user.locked_until,
    })
    .eq('id', user.id)
  return locking
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return
  try {
    const body = readJsonBody(req)
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password) {
      return sendJson(res, 401, INVALID_CREDENTIALS)
    }

    // Case-insensitive, backslash-safe lookup via SECURITY DEFINER helper.
    const { data: rows, error } = await db().rpc('panel_get_user_for_login', {
      p_username: username,
    })
    if (error) throw error
    const users = (rows ?? []) as PanelUser[]
    if (users.length !== 1) {
      // 0 = unknown user, >1 = ambiguous case collision. Neutral response.
      return sendJson(res, 401, INVALID_CREDENTIALS)
    }
    const user = users[0]

    // Lockout takes priority and is stated explicitly (identification already done).
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return sendJson(res, 423, {
        error: 'account_locked',
        locked_until: user.locked_until,
      })
    }

    // Inactive accounts get the neutral response (do not reveal existence/state).
    if (user.active === false) {
      return sendJson(res, 401, INVALID_CREDENTIALS)
    }

    if (!verifyPassword(password, user.password_hash)) {
      const locked = await registerFailure(user)
      return locked
        ? sendJson(res, 423, { error: 'account_locked' })
        : sendJson(res, 401, INVALID_CREDENTIALS)
    }

    await issueSession(res, user)
    return sendJson(res, 200, {
      step: 'authenticated',
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        display_name: user.display_name,
      },
    })
  } catch (e) {
    console.error('login error', e)
    return sendJson(res, 500, { error: 'server_error' })
  }
}
