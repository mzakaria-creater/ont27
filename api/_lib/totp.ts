import { authenticator } from 'otplib'
import qrcode from 'qrcode'
import { randomToken, hashToken } from './crypto.js'

// Allow a ±1 step (±30s) clock skew.
authenticator.options = { window: 1 }

export function generateTotpSecret(): string {
  return authenticator.generateSecret() // base32
}

export function totpKeyUri(username: string, secret: string): string {
  return authenticator.keyuri(username, 'OnTarget Panel', secret)
}

export async function totpQrDataUrl(keyUri: string): Promise<string> {
  return qrcode.toDataURL(keyUri, { margin: 1, width: 240 })
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
  /** Plaintext codes — shown to the user exactly once. */
  plaintext: string[]
  /** SHA-256 hashes — the only thing stored in the DB. */
  hashes: string[]
}

export function generateRecoveryCodes(count = 10): RecoverySet {
  const plaintext: string[] = []
  for (let i = 0; i < count; i++) {
    // 10 hex chars grouped as XXXXX-XXXXX for readability.
    const raw = randomToken(5) // 5 bytes = 10 hex chars
    plaintext.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`)
  }
  return { plaintext, hashes: plaintext.map((c) => hashToken(c.replace('-', ''))) }
}

/** Returns the index of a matching recovery code, or -1. */
export function matchRecoveryCode(input: string, hashes: string[]): number {
  const normalized = input.replace(/[\s-]/g, '').toLowerCase()
  if (!/^[0-9a-f]{10}$/.test(normalized)) return -1
  const h = hashToken(normalized)
  return hashes.findIndex((stored) => stored === h)
}
