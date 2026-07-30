import crypto from 'node:crypto'
import { env } from './env.js'

/** Lowercase-hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Constant-time comparison of two hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length === 0 || ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * The migrated `panel_users.password_hash` values are 64-char lowercase-hex
 * SHA-256 digests with no per-user salt column. We treat the scheme as
 * `sha256(pepper + password)` where the pepper is empty by default. If the
 * legacy system used a pepper/salt, set PANEL_PASSWORD_PEPPER to that value —
 * no code change required.
 */
export function verifyPassword(plaintext: string, storedHash: string): boolean {
  const candidate = sha256Hex(env.passwordPepper() + plaintext)
  return timingSafeEqualHex(candidate, storedHash.trim().toLowerCase())
}

/** A cryptographically-random opaque token (hex). Default 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

/** Store opaque tokens (refresh tokens, recovery codes) only as their hash. */
export function hashToken(raw: string): string {
  return sha256Hex(raw)
}

function encKey(): Buffer {
  const raw = env.totpEncKey()
  // Accept base64 or hex; must decode to exactly 32 bytes for AES-256.
  let key: Buffer
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex')
  } else {
    key = Buffer.from(raw, 'base64')
  }
  if (key.length !== 32) {
    throw new Error('PANEL_2FA_ENC_KEY must decode to 32 bytes (base64 or hex)')
  }
  return key
}

/** AES-256-GCM encrypt → base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

/** Reverse of encryptSecret. */
export function decryptSecret(packed: string): string {
  const buf = Buffer.from(packed, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
