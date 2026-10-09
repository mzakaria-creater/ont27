import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// Merchants directory. NEVER select api_key / secret_key / callback_secret /
// metadata here — credentials stay server-side only (see the exposed-secrets
// incident in the old dashboard).

export const merchantRoutes = new Hono<AuthEnv>()

merchantRoutes.use('*', requireAuth)

const SAFE_COLUMNS =
  'id, name, code, "MID", status, is_active, active, kyc_status, email, phone, business_type, country, country_code, base_currency, website, business_address, primary_contact_name, registration_id, blocked_amount, callback_url, master_merchant_id, operator_id, key_rotated_at, referred_by_user_id, created_at, updated_at'

merchantRoutes.get('/', requirePerm('merchants', 'can_view'), async (c) => {
  const [merchants, masters, hierarchy] = await Promise.all([
    db.from('merchants').select(SAFE_COLUMNS).order('name'),
    db.from('master_merchants').select('id, name, code:mid'),
    db.from('merchants_hierarchy').select('id, master_merchant_id, name, mid, active, created_at').order('name'),
  ])
  if (merchants.error) return c.json({ error: 'db_error', detail: merchants.error.message }, 500)
  if (masters.error) return c.json({ error: 'db_error', detail: masters.error.message }, 500)
  if (hierarchy.error) return c.json({ error: 'db_error', detail: hierarchy.error.message }, 500)

  // referred_by_user_id -> display name, resolved here rather than via an
  // embedded select: this table's rows don't carry a FK the PostgREST
  // embed syntax can follow (referred_by_user_id was added after the
  // table existed), so a plain lookup map is the simplest correct path.
  const referrerIds = [...new Set((merchants.data ?? []).map((m) => m.referred_by_user_id).filter((id): id is string => !!id))]
  const referrerNames = new Map<string, string>()
  if (referrerIds.length) {
    const { data: referrers } = await db.from('panel_users').select('id, display_name').in('id', referrerIds)
    for (const r of referrers ?? []) referrerNames.set(r.id, r.display_name)
  }
  const rows = (merchants.data ?? []).map((m) => ({ ...m, referred_by_name: m.referred_by_user_id ? referrerNames.get(m.referred_by_user_id) ?? null : null }))

  return c.json({ rows, masters: masters.data ?? [], hierarchy: hierarchy.data ?? [] })
})
