import { createClient } from '@supabase/supabase-js'

// Panel v2 DB: ontarget-panel-v2 (iwhjmhazcvctvipoasct), default `public` schema.
// Frontend uses the publishable key only; every table has RLS enabled, so data
// access goes through the panel API layer (custom panel_users JWT), not direct reads.
const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string

if (!url || !key) {
  console.warn('Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY')
}

export const supabase = createClient(url, key)

export const SUPABASE_URL = url
export const SUPABASE_KEY = key
