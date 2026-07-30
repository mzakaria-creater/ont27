import type { VercelResponse } from '@vercel/node'
import { db, type PanelUser } from './supabase.js'
import { env } from './env.js'
import { hashToken, randomToken } from './crypto.js'
import { signAccess } from './jwt.js'
import { ACCESS_COOKIE, REFRESH_COOKIE, setCookies } from './cookies.js'

/**
 * Issue a fresh session for a fully-authenticated user: mint a short-lived
 * access JWT + a long-lived opaque refresh token (stored only as a hash), and
 * set both as httpOnly cookies. Also resets lockout state and stamps last_login.
 */
export async function issueSession(
  res: VercelResponse,
  user: Pick<PanelUser, 'id' | 'username' | 'role'>,
): Promise<void> {
  const rawRefresh = randomToken(32)
  const expiresAt = new Date(Date.now() + env.refreshTtlSec * 1000).toISOString()

  const { error: insErr } = await db()
    .from('panel_refresh_tokens')
    .insert({ user_id: user.id, token_hash: hashToken(rawRefresh), expires_at: expiresAt })
  if (insErr) throw insErr

  await db()
    .from('panel_users')
    .update({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: new Date().toISOString(),
    })
    .eq('id', user.id)

  const access = await signAccess({
    user_id: user.id,
    username: user.username,
    role: user.role,
  })

  setCookies(res, [
    { name: ACCESS_COOKIE, value: access, maxAgeSec: env.accessTtlSec },
    { name: REFRESH_COOKIE, value: rawRefresh, maxAgeSec: env.refreshTtlSec },
  ])
}

export interface RotateResult {
  ok: boolean
  reason?: 'missing' | 'invalid' | 'expired' | 'revoked' | 'user_inactive'
}

/**
 * Validate a presented refresh token and, on success, rotate it: the old row is
 * marked revoked + replaced_by, a new refresh token is issued, and fresh access
 * + refresh cookies are set. Rotation makes each refresh token single-use and
 * enables reuse detection.
 */
export async function rotateRefresh(
  res: VercelResponse,
  rawRefresh: string | undefined,
): Promise<RotateResult> {
  if (!rawRefresh) return { ok: false, reason: 'missing' }

  const { data: row, error } = await db()
    .from('panel_refresh_tokens')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', hashToken(rawRefresh))
    .maybeSingle()
  if (error) throw error
  if (!row) return { ok: false, reason: 'invalid' }

  if (row.revoked_at) {
    // Reuse of an already-rotated token: revoke every live token for this user.
    await db()
      .from('panel_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', row.user_id)
      .is('revoked_at', null)
    return { ok: false, reason: 'revoked' }
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  const { data: user, error: uErr } = await db()
    .from('panel_users')
    .select('id, username, role, active')
    .eq('id', row.user_id)
    .maybeSingle()
  if (uErr) throw uErr
  if (!user || user.active === false) return { ok: false, reason: 'user_inactive' }

  const rawNew = randomToken(32)
  const expiresAt = new Date(Date.now() + env.refreshTtlSec * 1000).toISOString()
  const { data: inserted, error: insErr } = await db()
    .from('panel_refresh_tokens')
    .insert({ user_id: user.id, token_hash: hashToken(rawNew), expires_at: expiresAt })
    .select('id')
    .single()
  if (insErr) throw insErr

  await db()
    .from('panel_refresh_tokens')
    .update({ revoked_at: new Date().toISOString(), replaced_by: inserted.id })
    .eq('id', row.id)

  const access = await signAccess({
    user_id: user.id,
    username: user.username,
    role: user.role,
  })
  setCookies(res, [
    { name: ACCESS_COOKIE, value: access, maxAgeSec: env.accessTtlSec },
    { name: REFRESH_COOKIE, value: rawNew, maxAgeSec: env.refreshTtlSec },
  ])
  return { ok: true }
}
