import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { createClient } from '@supabase/supabase-js'
import { db } from './db.js'
import { ACCESS_COOKIE, verifyAccessToken } from './tokens.js'

// Pulls new rows from the OLD prod Supabase (where the Maven workers still
// write) into the panel-v2 DB. Same overlap-window upsert idea as
// scripts/migrate-from-old/delta.sh, limited to the hot tables the panel
// reads. Triggered by daily Vercel Cron (Bearer CRON_SECRET) AND by the
// panel itself while someone has it open (POST, authed, 60s throttle) —
// Hobby plan only allows daily crons.

export const deltaSyncRoutes = new Hono()

// table, pk, timestamp column to watermark on
const GROWING: { table: string; pk: string; ts: string }[] = [
  { table: 'maven_transactions', pk: 'tx_id', ts: 'first_seen_at' },
  { table: 'maven_payout_transactions', pk: 'maven_id', ts: 'first_seen_at' },
  { table: 'inbound_sms', pk: 'id', ts: 'created_at' },
]

const OVERLAP_MS = 5 * 60_000
const PAGE = 1000

let lastRunAt = 0

async function runSync(): Promise<Record<string, number | string>> {
  const oldUrl = process.env.OLD_SUPABASE_URL
  const oldKey = process.env.OLD_SERVICE_KEY
  if (!oldUrl || !oldKey) throw new Error('old_db_not_configured')
  const oldDb = createClient(oldUrl, oldKey, { auth: { persistSession: false } })

  const results: Record<string, number | string> = {}

  for (const { table, pk, ts } of GROWING) {
    try {
      const { data: maxRow, error: maxErr } = await db
        .from(table)
        .select(ts)
        .order(ts, { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      if (maxErr) throw new Error(maxErr.message)
      const maxTs = (maxRow as Record<string, string> | null)?.[ts]
      const since = maxTs
        ? new Date(new Date(maxTs).getTime() - OVERLAP_MS).toISOString()
        : '1970-01-01T00:00:00Z'

      let upserted = 0
      let offset = 0
      for (;;) {
        const { data: rows, error: fetchErr } = await oldDb
          .from(table)
          .select('*')
          .gte(ts, since)
          .order(ts, { ascending: true })
          .order(pk, { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (fetchErr) throw new Error(`old: ${fetchErr.message}`)
        if (!rows?.length) break

        // The old browser-worker stamps approved_by='Manual' (no actor name).
        // Drop that field from the payload so a real name recorded by the
        // panel is never overwritten by the generic label.
        if (table === 'maven_transactions') {
          for (const r of rows as Record<string, unknown>[]) {
            if (r.approved_by == null || r.approved_by === 'Manual') delete r.approved_by
          }
        }

        const { error: upErr } = await db.from(table).upsert(rows, { onConflict: pk })
        if (upErr) throw new Error(`upsert: ${upErr.message}`)
        upserted += rows.length
        if (rows.length < PAGE) break
        offset += rows.length
      }
      results[table] = upserted
    } catch (e) {
      results[table] = `error: ${(e as Error).message}`
    }
  }

  return results
}

// Daily Vercel Cron.
deltaSyncRoutes.get('/delta-sync', async (c) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  const results = await runSync().catch((e) => ({ error: (e as Error).message }))
  return c.json({ ok: true, results, at: new Date().toISOString() })
})

// Piggyback trigger from the authed panel (SMS rail polls this). Throttled
// per warm lambda; the overlap-window upsert keeps concurrent runs idempotent.
deltaSyncRoutes.post('/delta-sync', async (c) => {
  const token = getCookie(c, ACCESS_COOKIE)
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims) return c.json({ error: 'unauthenticated' }, 401)

  if (Date.now() - lastRunAt < 60_000) return c.json({ ok: true, skipped: 'throttled' })
  lastRunAt = Date.now()
  const results = await runSync().catch((e) => ({ error: (e as Error).message }))
  return c.json({ ok: true, results, at: new Date().toISOString() })
})
