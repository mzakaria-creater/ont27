import { Hono } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Panel-staff merchant referrals: any logged-in staff member gets a
// shareable link; a prospective merchant who fills in the form behind it
// lands as a 'pending' row here, and a staff member with merchants access
// later links it to the real merchants row once it's actually created
// (merchant creation itself happens outside this panel — see
// server/merchants.ts, which is read-only today).
//
// The link's security is an HS256 JWT signed with the same PANEL_JWT_SECRET
// panel session tokens use, carrying a distinct `purpose` claim so it can
// never be replayed as (or confused with) a real access token. Stateless —
// no separate link-secret table, and rotating PANEL_JWT_SECRET invalidates
// every outstanding referral link the same way it would a login session.
const JWT_SECRET = process.env.PANEL_JWT_SECRET
const REFERRAL_TTL_DAYS = 180
const REFERRAL_PURPOSE = 'merchant_referral'

function referralKey(): Uint8Array {
  if (!JWT_SECRET) throw new Error('Missing PANEL_JWT_SECRET (server env)')
  return new TextEncoder().encode(JWT_SECRET)
}

async function signReferralToken(userId: string): Promise<string> {
  return new SignJWT({ purpose: REFERRAL_PURPOSE })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${REFERRAL_TTL_DAYS}d`)
    .sign(referralKey())
}

async function verifyReferralToken(token: string): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, referralKey())
    if (payload.purpose !== REFERRAL_PURPOSE || typeof payload.sub !== 'string') return null
    return payload.sub
  } catch {
    return null
  }
}

export const referralRoutes = new Hono<AuthEnv>()

// Any authenticated panel user can mint their own link — referring
// merchants isn't gated to a specific role, "him" in the request is
// whoever is logged in and shares it.
referralRoutes.get('/my-link', requireAuth, async (c) => {
  const actor = c.get('actor')
  const token = await signReferralToken(actor.sub)
  return c.json({ token, path: `/refer?token=${token}` })
})

// Public — the landing page the referral link opens. Resolves who's
// behind the link (so the page can say "Referred by Joe") without
// exposing anything beyond a display name.
referralRoutes.get('/landing', async (c) => {
  const userId = await verifyReferralToken(c.req.query('token') ?? '')
  if (!userId) return c.json({ error: 'invalid_or_expired_link' }, 410)
  const { data: referrer } = await db.from('panel_users').select('display_name, active').eq('id', userId).maybeSingle()
  if (!referrer || !referrer.active) return c.json({ error: 'invalid_or_expired_link' }, 410)
  return c.json({ referrer_name: referrer.display_name })
})

// Public — lead capture. Never creates a merchants row directly (that
// needs KYC review); it's a pending lead a staff member reviews and, once
// satisfied, links to the real merchant record.
referralRoutes.post('/leads', async (c) => {
  const body = await c.req.json().catch(() => null)
  const userId = await verifyReferralToken(typeof body?.token === 'string' ? body.token : '')
  if (!userId) return c.json({ error: 'invalid_or_expired_link' }, 410)
  const businessName = typeof body?.business_name === 'string' ? body.business_name.trim().slice(0, 200) : ''
  if (!businessName) return c.json({ error: 'business_name_required' }, 400)
  const contactName = typeof body?.contact_name === 'string' ? body.contact_name.trim().slice(0, 120) || null : null
  const phone = typeof body?.phone === 'string' ? body.phone.trim().slice(0, 30) || null : null
  const email = typeof body?.email === 'string' ? body.email.trim().slice(0, 200) || null : null
  const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, 1000) || null : null
  const { data: lead, error } = await db
    .from('merchant_referral_leads')
    .insert({ referrer_user_id: userId, business_name: businessName, contact_name: contactName, phone, email, notes })
    .select('id, created_at')
    .single()
  if (error || !lead) {
    console.error('merchant_referral_leads insert failed:', error?.message)
    return c.json({ error: 'lead_create_failed' }, 500)
  }
  return c.json({ ok: true, lead }, 201)
})

// Authenticated — review leads. ?scope=mine narrows to the caller's own
// referrals; without it this is the full queue, gated the same as the
// merchants directory itself.
referralRoutes.get('/leads', requireAuth, requirePerm('merchants', 'can_view'), async (c) => {
  const actor = c.get('actor')
  let query = db
    .from('merchant_referral_leads')
    .select('id, referrer_user_id, business_name, contact_name, phone, email, notes, status, linked_merchant_id, created_at, panel_users(display_name)')
    .order('created_at', { ascending: false })
  if (c.req.query('scope') === 'mine') query = query.eq('referrer_user_id', actor.sub)
  const { data, error } = await query
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  return c.json({ rows: data ?? [] })
})

// Authenticated — dismiss a lead, or link it to an existing merchants row
// (tagging that merchant's referred_by_user_id from the lead's referrer).
referralRoutes.patch('/leads/:id', requireAuth, requirePerm('merchants', 'can_edit'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)

  if (body?.action === 'dismiss') {
    const { error } = await db
      .from('merchant_referral_leads')
      .update({ status: 'dismissed', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
    return c.json({ ok: true })
  }

  if (body?.action === 'convert') {
    const merchantId = typeof body?.merchant_id === 'string' ? body.merchant_id : ''
    if (!merchantId) return c.json({ error: 'merchant_id_required' }, 400)
    const { data: lead, error: leadErr } = await db
      .from('merchant_referral_leads')
      .select('referrer_user_id, status')
      .eq('id', id)
      .maybeSingle()
    if (leadErr || !lead) return c.json({ error: 'not_found' }, 404)
    if (lead.status !== 'pending') return c.json({ error: 'lead_not_pending' }, 409)
    const { error: merchantErr } = await db
      .from('merchants')
      .update({ referred_by_user_id: lead.referrer_user_id })
      .eq('id', merchantId)
    if (merchantErr) return c.json({ error: 'db_error', detail: merchantErr.message }, 500)
    const { error: leadUpdateErr } = await db
      .from('merchant_referral_leads')
      .update({ status: 'converted', linked_merchant_id: merchantId, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (leadUpdateErr) return c.json({ error: 'db_error', detail: leadUpdateErr.message }, 500)
    return c.json({ ok: true })
  }

  return c.json({ error: 'invalid_action' }, 400)
})
