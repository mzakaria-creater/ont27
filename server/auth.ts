import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { db } from './db.js'
import {
  ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_TTL_SEC, REFRESH_TTL_SEC_REMEMBER,
  signAccessToken, verifyAccessToken, verifyPassword, hashPassword,
  issueRefreshToken, rotateRefreshToken, revokeRefreshToken,
} from './tokens.js'

const MAX_FAILED = 5
const LOCK_MINUTES = 15
const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL

function clientIp(c: Context): string | null {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (fwd && /^[0-9a-fA-F:.]+$/.test(fwd)) return fwd
  return null
}

async function audit(c: Context, action: string, entityId: string, actor?: { id?: string; name?: string }) {
  // actor_type is constrained to auto_trigger | manual_panel | system;
  // everything a human does through the panel is manual_panel.
  const { error } = await db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor?.id ?? null,
    actor_name: actor?.name ?? null,
    action,
    entity: 'panel_users',
    entity_id: entityId,
    ip: clientIp(c),
  })
  if (error) console.error(`audit_log insert failed (${action}):`, error.message)
}

// The access cookie always carries maxAge (short-lived regardless of "remember
// me" — it's re-minted from the refresh cookie on every /refresh anyway). The
// refresh cookie's persistence is what "remember me" actually controls: with
// remember=false we omit maxAge so it's a session cookie the browser drops on
// close, backed by a matching short-lived DB row (REFRESH_TTL_SEC_SESSION) so
// a cookie that somehow survives (session restore, etc.) still expires soon.
function setAuthCookies(c: Context, access: string, refresh: string, remember: boolean) {
  setCookie(c, ACCESS_COOKIE, access, {
    httpOnly: true, sameSite: 'Lax', secure: isProd, path: '/', maxAge: ACCESS_TTL_SEC,
  })
  setCookie(c, REFRESH_COOKIE, refresh, {
    httpOnly: true, sameSite: 'Lax', secure: isProd, path: '/api/auth',
    ...(remember ? { maxAge: REFRESH_TTL_SEC_REMEMBER } : {}),
  })
}

function clearAuthCookies(c: Context) {
  deleteCookie(c, ACCESS_COOKIE, { path: '/' })
  deleteCookie(c, REFRESH_COOKIE, { path: '/api/auth' })
}

export const authRoutes = new Hono()

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const remember = body?.remember !== false // default true — matches the prior always-30d behavior
  if (!username || !password) return c.json({ error: 'missing_credentials' }, 400)

  // Case-insensitive, backslash-safe lookup via SECURITY DEFINER helper
  // (created by the 2026-07-31 session; 0 rows = unknown, >1 = case collision).
  const { data: rows } = await db.rpc('panel_get_user_for_login', { p_username: username })
  const user = Array.isArray(rows) && rows.length === 1 ? rows[0] : null

  if (!user || !user.active) {
    await audit(c, 'auth.login_failed', username)
    return c.json({ error: 'invalid_credentials' }, 401)
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return c.json({ error: 'locked', until: user.locked_until }, 423)
  }

  const { ok, needsUpgrade } = await verifyPassword(password, user.password_hash)
  if (!ok) {
    const failed = (user.failed_login_count ?? 0) + 1
    await db.from('panel_users').update({
      failed_login_count: failed,
      locked_until: failed >= MAX_FAILED
        ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
        : null,
    }).eq('id', user.id)
    await audit(c, 'auth.login_failed', user.id, { id: user.id, name: user.username })
    return c.json({ error: 'invalid_credentials' }, 401)
  }

  const updates: Record<string, unknown> = {
    failed_login_count: 0,
    locked_until: null,
    last_login_at: new Date().toISOString(),
  }
  if (needsUpgrade) updates.password_hash = await hashPassword(password)
  await db.from('panel_users').update(updates).eq('id', user.id)

  const access = await signAccessToken({ sub: user.id, username: user.username, role: user.role })
  const refresh = await issueRefreshToken(user.id, remember)
  setAuthCookies(c, access, refresh, remember)
  await audit(c, 'auth.login', user.id, { id: user.id, name: user.username })

  return c.json({
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  })
})

authRoutes.post('/refresh', async (c) => {
  const raw = getCookie(c, REFRESH_COOKIE)
  if (!raw) return c.json({ error: 'no_refresh_token' }, 401)

  const rotated = await rotateRefreshToken(raw)
  if (!rotated) {
    clearAuthCookies(c)
    return c.json({ error: 'invalid_refresh_token' }, 401)
  }

  const { data: user } = await db
    .from('panel_users')
    .select('id, username, display_name, role, active')
    .eq('id', rotated.userId)
    .maybeSingle()
  if (!user || !user.active) {
    clearAuthCookies(c)
    return c.json({ error: 'user_inactive' }, 401)
  }

  const access = await signAccessToken({ sub: user.id, username: user.username, role: user.role })
  setAuthCookies(c, access, rotated.newToken, rotated.remember)
  return c.json({ ok: true })
})

authRoutes.post('/logout', async (c) => {
  const raw = getCookie(c, REFRESH_COOKIE)
  const token = getCookie(c, ACCESS_COOKIE)
  if (raw) await revokeRefreshToken(raw)
  if (token) {
    const claims = await verifyAccessToken(token)
    if (claims) await audit(c, 'auth.logout', claims.sub, { id: claims.sub, name: claims.username })
  }
  clearAuthCookies(c)
  return c.json({ ok: true })
})

// --- 2FA enrollment (optional, from an authenticated session) ---
// FINAL product decision 2026-07-31: 2FA/TOTP is NOT required anywhere —
// neither at login nor as an extra gate on can_approve actions
// (deposit approve/decline). panel_users_2fa and these enrollment
// endpoints stay in place unused; re-enabling requires a new explicit
// product decision. See docs/AUTH.md.

authRoutes.post('/2fa/setup', async (c) => {
  const token = getCookie(c, ACCESS_COOKIE)
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims) return c.json({ error: 'unauthenticated' }, 401)

  const { generateTotpSecret, encryptSecret, totpQrDataUrl } = await import('./twofa.js')
  const secret = generateTotpSecret()
  const { error } = await db.from('panel_users_2fa').upsert(
    {
      user_id: claims.sub,
      totp_secret_enc: encryptSecret(secret),
      enabled_at: null,
      recovery_codes_hash: [],
    },
    { onConflict: 'user_id' },
  )
  if (error) {
    console.error('2fa setup failed:', error.message)
    return c.json({ error: 'server_error' }, 500)
  }
  const qr = await totpQrDataUrl(claims.username, secret)
  return c.json({ qr_data_url: qr, manual_entry_key: secret })
})

authRoutes.post('/2fa/enable', async (c) => {
  const token = getCookie(c, ACCESS_COOKIE)
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims) return c.json({ error: 'unauthenticated' }, 401)

  const body = await c.req.json().catch(() => null)
  const totpCode = typeof body?.totp_code === 'string' ? body.totp_code.trim() : ''
  if (!totpCode) return c.json({ error: 'missing_totp_code' }, 400)

  const { data: twofa } = await db
    .from('panel_users_2fa')
    .select('totp_secret_enc, enabled_at')
    .eq('user_id', claims.sub)
    .maybeSingle()
  if (!twofa) return c.json({ error: 'not_enrolled' }, 409)

  const { decryptSecret, verifyTotp, generateRecoveryCodes } = await import('./twofa.js')
  if (!verifyTotp(totpCode, decryptSecret(twofa.totp_secret_enc))) {
    return c.json({ error: 'invalid_totp' }, 401)
  }

  const { plaintext, hashes } = generateRecoveryCodes(10)
  const { error } = await db
    .from('panel_users_2fa')
    .update({ enabled_at: new Date().toISOString(), recovery_codes_hash: hashes })
    .eq('user_id', claims.sub)
  if (error) {
    console.error('2fa enable failed:', error.message)
    return c.json({ error: 'server_error' }, 500)
  }
  await audit(c, 'auth.2fa_enabled', claims.sub, { id: claims.sub, name: claims.username })
  // Recovery codes are shown exactly once — the UI must force the user to save them.
  return c.json({ recovery_codes: plaintext })
})

authRoutes.get('/me', async (c) => {
  const token = getCookie(c, ACCESS_COOKIE)
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims) return c.json({ error: 'unauthenticated' }, 401)

  const [{ data: user }, { data: perms }, { data: twofa }] = await Promise.all([
    db.from('panel_users')
      .select('id, username, display_name, role, active, prefs, last_login_at')
      .eq('id', claims.sub).maybeSingle(),
    db.from('role_page_permissions')
      .select('page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export')
      .eq('role_key', claims.role),
    db.from('panel_users_2fa')
      .select('enabled_at').eq('user_id', claims.sub).maybeSingle(),
  ])

  if (!user || !user.active) return c.json({ error: 'user_inactive' }, 401)

  return c.json({
    user: {
      id: user.id, username: user.username, display_name: user.display_name,
      role: user.role, prefs: user.prefs, last_login_at: user.last_login_at,
    },
    permissions: perms ?? [],
    twofa_enrolled: !!twofa?.enabled_at,
  })
})
