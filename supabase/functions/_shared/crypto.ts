// Web Crypto equivalents of the node:crypto primitives server/pay.ts and its
// helpers use. Deliberately NOT using node:crypto / npm compat here — the
// existing panel-login-fallback function already avoids it (it hand-rolls
// its own sha256Hex via crypto.subtle instead), which is a signal that stays
// safer than trusting Node compat on this project's edge runtime. Web Crypto
// is a standard, always-available Deno API, so these have no import risk.

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Matches createHash('sha256').update(value).digest('hex') */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toHex(digest)
}

/** Matches createHmac('sha256', secret).update(value).digest('hex') */
export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return toHex(signature)
}

/** Matches randomBytes(byteLength).toString('hex') */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}
