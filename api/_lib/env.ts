// Server-side environment. These variables live ONLY in the serverless runtime
// (Vercel Project → Settings → Environment Variables). They must never be
// prefixed VITE_ and never reach the browser bundle.

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(`Missing required server env var: ${name}`)
  }
  return v
}

function optional(name: string, fallback = ''): string {
  const v = process.env[name]
  return v == null ? fallback : v
}

export const env = {
  // Supabase (Panel v2 — iwhjmhazcvctvipoasct). Service role stays server-side.
  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),

  // Dedicated panel auth signing secret — INDEPENDENT of any Supabase secret.
  jwtSecret: () => required('PANEL_AUTH_JWT_SECRET'),

  // AES-256-GCM key (base64 or hex, 32 bytes) used to encrypt TOTP secrets at rest.
  totpEncKey: () => required('PANEL_2FA_ENC_KEY'),

  // Optional server-side pepper mixed into the password hash. Empty by default —
  // the migrated hashes are lowercase-hex sha256(password) with no pepper. If a
  // real-password login test fails, set this (or PANEL_PASSWORD_SCHEME) to match
  // the legacy scheme instead of guessing.
  passwordPepper: () => optional('PANEL_PASSWORD_PEPPER', ''),

  // Session lifetimes.
  accessTtlSec: 20 * 60, // 20 minutes
  refreshTtlSec: 7 * 24 * 60 * 60, // 7 days
  stageTtlSec: 5 * 60, // 5 minutes (2FA challenge / enrollment window)

  // Lockout policy.
  maxFailedLogins: 5,
  lockMinutes: 15,

  issuer: 'ont27-panel',
}
