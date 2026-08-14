import { SignJWT, jwtVerify } from 'jose'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db } from './db.js'

const JWT_SECRET = process.env.PANEL_JWT_SECRET
if (!JWT_SECRET) throw new Error('Missing PANEL_JWT_SECRET (server env)')
const key = new TextEncoder().encode(JWT_SECRET)

export const ACCESS_COOKIE = 'ot_access'
export const REFRESH_COOKIE = 'ot_refresh'
export const ACCESS_TTL_SEC = 15 * 60
// "Remember me" controls both the refresh token's DB-side expiry and whether
// its cookie persists past the browser session (see setAuthCookies in auth.ts).
export const REFRESH_TTL_SEC_REMEMBER = 30 * 24 * 60 * 60
export const REFRESH_TTL_SEC_SESSION = 24 * 60 * 60
const BCRYPT_COST = 12

export interface AccessClaims {
  sub: string
  username: string
  role: string
  [claim: string]: unknown
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(key)
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key)
    return payload as AccessClaims
  } catch {
    return null
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// Legacy panel_users hashes are unsalted SHA-256 hex; new hashes are bcrypt.
// Returns whether the password matched and whether the stored hash needs upgrading.
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<{ ok: boolean; needsUpgrade: boolean }> {
  if (storedHash.startsWith('$2')) {
    return { ok: await bcrypt.compare(password, storedHash), needsUpgrade: false }
  }
  if (/^[0-9a-f]{64}$/.test(storedHash)) {
    const candidate = Buffer.from(sha256Hex(password), 'hex')
    const stored = Buffer.from(storedHash, 'hex')
    const ok = candidate.length === stored.length && timingSafeEqual(candidate, stored)
    return { ok, needsUpgrade: ok }
  }
  return { ok: false, needsUpgrade: false }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST)
}

export async function issueRefreshToken(userId: string, remember: boolean): Promise<string> {
  const raw = randomBytes(32).toString('hex')
  const ttlSec = remember ? REFRESH_TTL_SEC_REMEMBER : REFRESH_TTL_SEC_SESSION
  const { error } = await db.from('panel_refresh_tokens').insert({
    user_id: userId,
    token_hash: sha256Hex(raw),
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    remember,
  })
  if (error) throw new Error(`refresh token insert failed: ${error.message}`)
  return raw
}

export interface RotationResult {
  userId: string
  newToken: string
  remember: boolean
}

// Rotates a refresh token. A revoked token being replayed is a theft signal:
// every live token for that user gets revoked and the caller must re-login.
export async function rotateRefreshToken(raw: string): Promise<RotationResult | null> {
  const hash = sha256Hex(raw)
  const { data: row } = await db
    .from('panel_refresh_tokens')
    .select('id, user_id, expires_at, revoked_at, remember')
    .eq('token_hash', hash)
    .maybeSingle()
  if (!row) return null

  if (row.revoked_at) {
    await db
      .from('panel_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', row.user_id)
      .is('revoked_at', null)
    return null
  }
  if (new Date(row.expires_at).getTime() < Date.now()) return null

  const remember = row.remember ?? true
  const newToken = randomBytes(32).toString('hex')
  const ttlSec = remember ? REFRESH_TTL_SEC_REMEMBER : REFRESH_TTL_SEC_SESSION
  const { data: inserted, error } = await db
    .from('panel_refresh_tokens')
    .insert({
      user_id: row.user_id,
      token_hash: sha256Hex(newToken),
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      remember,
    })
    .select('id')
    .single()
  if (error || !inserted) throw new Error(`refresh rotation failed: ${error?.message}`)

  await db
    .from('panel_refresh_tokens')
    .update({ revoked_at: new Date().toISOString(), replaced_by: inserted.id })
    .eq('id', row.id)

  return { userId: row.user_id, newToken, remember }
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await db
    .from('panel_refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', sha256Hex(raw))
    .is('revoked_at', null)
}
