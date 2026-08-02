import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

// Client for the OLD prod Supabase — where the Maven workers and the
// control-room RPCs (dashboard_*, pending_*, tx_*) actually live.
// Decisions MUST be propagated there or they have no real-world effect.

let client: SupabaseClient | null = null

export function oldDb(): SupabaseClient | null {
  const url = process.env.OLD_SUPABASE_URL
  const key = process.env.OLD_SERVICE_KEY
  if (!url || !key) return null
  client ??= createClient(url, key, { auth: { persistSession: false } })
  return client
}
