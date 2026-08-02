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
  'id, name, code, "MID", status, is_active, active, kyc_status, email, phone, business_type, country, country_code, base_currency, website, business_address, primary_contact_name, registration_id, blocked_amount, callback_url, master_merchant_id, operator_id, key_rotated_at, created_at, updated_at'

merchantRoutes.get('/', requirePerm('merchants', 'can_view'), async (c) => {
  const [merchants, masters] = await Promise.all([
    db.from('merchants').select(SAFE_COLUMNS).order('name'),
    db.from('master_merchants').select('id, name, code, provider, status, country_code, base_currency'),
  ])
  if (merchants.error) return c.json({ error: 'db_error', detail: merchants.error.message }, 500)
  if (masters.error) return c.json({ error: 'db_error', detail: masters.error.message }, 500)
  return c.json({ rows: merchants.data ?? [], masters: masters.data ?? [] })
})
