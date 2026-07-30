import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { env } from './env.js'

function secret(): Uint8Array {
  return new TextEncoder().encode(env.jwtSecret())
}

export interface AccessClaims extends JWTPayload {
  typ: 'access'
  user_id: string
  username: string
  role: string
}

export interface StageClaims extends JWTPayload {
  typ: 'stage'
  stage: 'totp' | 'enroll'
  user_id: string
  username: string
  role: string
}

/** Short-lived access token embedded in the httpOnly access cookie. */
export async function signAccess(u: {
  user_id: string
  username: string
  role: string
}): Promise<string> {
  return new SignJWT({ typ: 'access', ...u })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(env.issuer)
    .setIssuedAt()
    .setExpirationTime(`${env.accessTtlSec}s`)
    .sign(secret())
}

/**
 * A short-lived "stage" token that binds the second step of login (TOTP verify
 * or TOTP enrollment) to the user who just passed the password check. It is NOT
 * an access token — the guard rejects `typ:'stage'`.
 */
export async function signStage(
  stage: 'totp' | 'enroll',
  u: { user_id: string; username: string; role: string },
): Promise<string> {
  return new SignJWT({ typ: 'stage', stage, ...u })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(env.issuer)
    .setIssuedAt()
    .setExpirationTime(`${env.stageTtlSec}s`)
    .sign(secret())
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret(), { issuer: env.issuer })
  if (payload.typ !== 'access') throw new Error('not an access token')
  return payload as AccessClaims
}

export async function verifyStage(
  token: string,
  stage: 'totp' | 'enroll',
): Promise<StageClaims> {
  const { payload } = await jwtVerify(token, secret(), { issuer: env.issuer })
  if (payload.typ !== 'stage' || payload.stage !== stage) {
    throw new Error('invalid stage token')
  }
  return payload as StageClaims
}
