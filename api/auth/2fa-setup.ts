import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from '../_lib/supabase.js'
import { verifyStage } from '../_lib/jwt.js'
import { encryptSecret } from '../_lib/crypto.js'
import { generateTotpSecret, totpKeyUri, totpQrDataUrl } from '../_lib/totp.js'
import { methodGuard, readJsonBody, sendJson } from '../_lib/http.js'

/**
 * Step 1 of first-time 2FA enrollment (called with the `enroll_token` returned
 * by /api/auth/login). Generates a TOTP secret, stores it encrypted but
 * UNCONFIRMED (enabled_at = null), and returns a QR code for the user's
 * authenticator app. The secret only takes effect once /2fa-enable verifies a
 * live code from it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return
  try {
    const body = readJsonBody(req)
    const enrollToken = typeof body.enroll_token === 'string' ? body.enroll_token : ''
    if (!enrollToken) return sendJson(res, 400, { error: 'missing_enroll_token' })

    let claims
    try {
      claims = await verifyStage(enrollToken, 'enroll')
    } catch {
      return sendJson(res, 401, { error: 'invalid_or_expired_enroll_token' })
    }

    const secret = generateTotpSecret()
    const { error } = await db().from('panel_users_2fa').upsert(
      {
        user_id: claims.user_id,
        totp_secret_enc: encryptSecret(secret),
        enabled_at: null,
        recovery_codes_hash: [],
      },
      { onConflict: 'user_id' },
    )
    if (error) throw error

    const uri = totpKeyUri(claims.username, secret)
    const qr = await totpQrDataUrl(uri)
    return sendJson(res, 200, {
      qr_data_url: qr,
      manual_entry_key: secret,
      enroll_token: enrollToken,
    })
  } catch (e) {
    console.error('2fa-setup error', e)
    return sendJson(res, 500, { error: 'server_error' })
  }
}
