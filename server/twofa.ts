// TOTP 2FA — ported from the parallel session's api/_lib/{totp,crypto}.ts.
// Secrets are AES-256-GCM encrypted at rest (PANEL_2FA_ENC_KEY); recovery
// codes stored only as SHA-256 hashes. 2FA is NOT enforced at login
// (explicit product decision 2026-07-30) — enrollment stays available from an
// authenticated session so it can be turned back on without a redesign.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { authenticator } from 'otplib'
import QRCode from 'qrcode'
import { sha256Hex } from './tokens.js'

authenticator.options = { window: 1 } // ±30s clock skew

function encKey(): Buffer {
  const raw = process.env.PANEL_2FA_ENC_KEY
  if (!raw) throw new Error('Missing PANEL_2FA_ENC_KEY (server env)')
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('PANEL_2FA_ENC_KEY must decode to 32 bytes')
  return key
}

/** AES-256-GCM encrypt → base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

export function decryptSecret(packed: string): string {
  const buf = Buffer.from(packed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', encKey(), buf.subarray(0, 12))
  decipher.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret()
}

export async function totpQrDataUrl(username: string, secret: string): Promise<string> {
  const uri = authenticator.keyuri(username, 'OnTarget Panel', secret)
  return QRCode.toDataURL(uri, { margin: 1, width: 240 })
}

export function verifyTotp(token: string, secret: string): boolean {
  const clean = token.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  try {
    return authenticator.verify({ token: clean, secret })
  } catch {
    return false
  }
}

export interface RecoverySet {
  plaintext: string[]
  hashes: string[]
}

export function generateRecoveryCodes(count = 10): RecoverySet {
  const plaintext: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex')
    plaintext.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`)
  }
  return { plaintext, hashes: plaintext.map((c) => sha256Hex(c.replace('-', ''))) }
}
