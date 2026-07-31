import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env.js'

let client: SupabaseClient | null = null

/**
 * Service-role Supabase client. Server-side ONLY — the service_role key bypasses
 * RLS and must never be exposed to the browser. Created lazily so importing this
 * module does not throw when env is absent (e.g. during type-checks).
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return client
}

export interface PanelUser {
  id: string
  username: string
  password_hash: string
  display_name: string | null
  role: string
  active: boolean | null
  prefs: Record<string, unknown>
  created_at: string | null
  last_login_at: string | null
  failed_login_count: number
  locked_until: string | null
}
