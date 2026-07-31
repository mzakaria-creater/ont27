import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from '../_lib/supabase.js'
import { verifyStage } from '../_lib/jwt.js'
import { decryptSecret } from '../_lib/crypto.js'
import { verifyTotp, generateRecoveryCodes } from '../_lib/totp.js'
import { issueSession } from '../_lib/session.js'
import { methodGuard, readJsonBody, sendJson } from '../_lib/http.js'

/**
 * Step 2 of first-time 2FA enrollment: confirm the user actually captured the
 * secret by verifying a live code, then flip enabled_at, hand out one-time
 * recovery codes (shown once), and log them straight into a full session.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!methodGuard(req, res, 'POST')) return
  try {
    const body = readJsonBody(req)
    const enrollToken = typeof body.enroll_token === 'string' ? body.enroll_token : ''
    const totpCode = typeof body.totp_code === 'string' ? body.totp_code.trim() : ''
    if (!enrollToken || !totpCode) {
      return sendJson(res, 400, { error: 'missing_fields' })
    }

    let claims
    try {
      claims = await verifyStage(enrollToken, 'enroll')
    } catch {
      return sendJson(res, 401, { error: 'invalid_or_expired_enroll_token' })
    }

    const { data: twofa, error: readErr } = await db()
      .from('panel_users_2fa')
      .select('totp_secret_enc, enabled_at')
      .eq('user_id', claims.user_id)
      .maybeSingle()
    if (readErr) throw readErr
    if (!twofa) return sendJson(res, 409, { error: 'not_enrolled' })

    const secret = decryptSecret(twofa.totp_secret_enc)
    if (!verifyTotp(totpCode, secret)) {
      return sendJson(res, 401, { error: 'invalid_totp' })
    }

    const { plaintext, hashes } = generateRecoveryCodes(10)
    const { error: updErr } = await db()
      .from('panel_users_2fa')
      .update({ enabled_at: new Date().toISOString(), recovery_codes_hash: hashes })
      .eq('user_id', claims.user_id)
    if (updErr) throw updErr

    await issueSession(res, {
      id: claims.user_id,
      username: claims.username,
      role: claims.role,
    })

    return sendJson(res, 200, {
      step: 'authenticated',
      recovery_codes: plaintext, // shown exactly once — UI must force the user to save these
      user: { id: claims.user_id, username: claims.username, role: claims.role },
    })
  } catch (e) {
    console.error('2fa-enable error', e)
    return sendJson(res, 500, { error: 'server_error' })
  }
}
