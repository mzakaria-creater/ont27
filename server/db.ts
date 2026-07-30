import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

// Server-side admin client for panel-v2 (iwhjmhazcvctvipoasct).
// Uses the secret key — bypasses RLS, so it must NEVER be imported from src/.
const url = process.env.SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY

if (!url || !secret) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY (server env)')
}

export const db = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
  // Realtime is unused server-side; ws transport just satisfies Node 20 (no native WebSocket)
  realtime: { transport: ws as never },
})
