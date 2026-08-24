import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { createClient } from '@supabase/supabase-js'
import { db } from './db.js'
import { ACCESS_COOKIE, verifyAccessToken } from './tokens.js'
import { repairPaidSmsMatches } from './smsMatcher.js'
import { produceRiskAlerts } from './riskAlerts.js'
import { autoLinkWithdrawalSms } from './payoutSmsMatcher.js'

// Pulls new rows from the OLD prod Supabase (where the Maven workers still
// write) into the panel-v2 DB. Same overlap-window upsert idea as
// scripts/migrate-from-old/delta.sh, limited to the hot tables the panel
// reads. Triggered by daily Vercel Cron (Bearer CRON_SECRET) AND by the
// panel itself while someone has it open (POST, authed, 60s throttle) —
// Hobby plan only allows daily crons.

export const deltaSyncRoutes = new Hono()

// table, pk, timestamp column to watermark on. `updatedTs` (when set) drives a
// second pass that re-pulls rows whose STATUS changed on the old DB after they
// were first synced — without it a tx that flips DECLINED→PAID upstream stays
// frozen at its first-synced status here forever (this is exactly what made
// ontarget_ref=777021614 read DECLINED locally while the old prod DB said PAID).
const GROWING: { table: string; pk: string; ts: string; updatedTs?: string }[] = [
  { table: 'maven_transactions', pk: 'tx_id', ts: 'first_seen_at', updatedTs: 'last_status_change' },
  { table: 'maven_payout_transactions', pk: 'maven_id', ts: 'first_seen_at', updatedTs: 'updated_utc' },
  { table: 'inbound_sms', pk: 'id', ts: 'created_at' },
  // 2026-08-18: these two were never synced, so both silently froze while the
  // old project kept writing — crm_clients last moved 2026-08-02 (310 rows
  // behind) and api_risk_blacklist 2026-07-30 (13 blocked numbers behind).
  // A stale blacklist is the dangerous one: a number the old system had
  // already blocked for repeated declines was still accepted here.
  // Both carry uuid PKs that the original migration preserved, so the upsert
  // is idempotent and the first run backfills the whole gap on its own.
  { table: 'crm_clients', pk: 'id', ts: 'created_at', updatedTs: 'updated_at' },
  // Mirrored without a unique key on (type, value): this side is a copy, not a
  // source. Upstream now enforces that key, so duplicates cannot arrive — but
  // an unblock-then-reblock upstream would send a fresh id while the stale id
  // still sat here, and a local unique key would turn that into a hard upsert
  // failure for the whole batch. Delta sync carries inserts and updates only,
  // never deletes.
  { table: 'api_risk_blacklist', pk: 'id', ts: 'created_at' },
  // 2026-08-22: also never synced, and frozen since the original migration —
  // 18 rows here against 23 upstream. The panel's wallet pages, the treasury
  // hub and the wallet-movements report all read this table, so a wallet added
  // to a device upstream was invisible to every one of them. It has no
  // created_at, so `updatedTs` alone drives it; the update pass is the only
  // pass that can move a config row anyway.
  //
  // Deletes still do not propagate — a wallet retired upstream lingers here
  // until someone removes it. That is the same gap every table in this list
  // has, and the upstream convention is to rename a retired wallet
  // 'RETIRED_…' rather than delete it, which does carry across as an update.
  { table: 'wallet_device_map', pk: 'to_account_number', ts: 'updated_at', updatedTs: 'updated_at' },
]

const OVERLAP_MS = 5 * 60_000
// The update pass overlaps a full day: the panel writes its own local
// last_status_change on manual decisions, which can push the watermark past
// not-yet-synced upstream changes. Upserts are idempotent and a day of status
// flips is small, so the wide window costs little and misses nothing.
const UPDATED_OVERLAP_MS = 24 * 60 * 60_000
const PAGE = 1000

// Two cadences, because the two passes cost very different amounts.
//
// The "new rows" pass walks a 5-minute overlap window and normally returns a
// handful of rows — cheap enough to run every few seconds, and it is the one
// that decides how quickly a fresh transaction shows up in the panel.
//
// The "updated" pass re-pulls everything whose status moved in the last 24h so
// an upstream flip is never missed. That is a much bigger read, and running it
// at the fast cadence would multiply load for no gain in how fast new rows
// appear.
const FAST_THROTTLE_MS = 5_000
// Provider collectors update an existing row when NagoPay/PayFuture changes
// its status. Re-read a bounded recent window on every fast pass so those
// changes are live too; the wider full pass remains the repair safety net.
const FAST_UPDATED_LOOKBACK_MS = 10 * 60_000
let lastFastRunAt = 0
let activeSync: Promise<Record<string, number | string>> | null = null

async function claimDistributedLease(ttlSeconds: number): Promise<boolean> {
  const { data, error } = await db.rpc('claim_provider_sync_lease', {
    p_lease_name: 'provider_delta_sync', p_ttl_seconds: ttlSeconds,
  })
  if (error) {
    console.error('provider sync lease failed:', error.message)
    return false
  }
  return data === true
}

async function runSync(mode: 'fast' | 'full' = 'full'): Promise<Record<string, number | string>> {
  const oldUrl = process.env.OLD_SUPABASE_URL
  const oldKey = process.env.OLD_SERVICE_KEY
  if (!oldUrl || !oldKey) throw new Error('old_db_not_configured')
  const oldDb = createClient(oldUrl, oldKey, { auth: { persistSession: false } })

  const results: Record<string, number | string> = {}

  async function pullSince(table: string, pk: string, col: string, since: string): Promise<number> {
    let upserted = 0
    let offset = 0
    for (;;) {
      const { data: rows, error: fetchErr } = await oldDb
        .from(table)
        .select('*')
        .gte(col, since)
        .order(col, { ascending: true })
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
          // The upstream collector emits a trailing TAB on the MelBet
          // sub-merchant ("NGPay-MelBet-Prod-EGP-Others\t"), which splits one
          // real sub-merchant into two values — 3,385 rows carried the tab
          // against 8,739 clean ones, so every GROUP BY sub_merchant listed
          // MelBet twice and any `= 'NGPay-MelBet-Prod-EGP-Others'` filter
          // (including a sub-merchant-scoped automation rule) silently missed
          // 28% of its transactions. Normalise on the way in; the upstream
          // collector still needs the same fix at the source.
          for (const k of ['merchant', 'sub_merchant', 'master_merchant']) {
            if (typeof r[k] === 'string') r[k] = (r[k] as string).trim()
          }
        }
      }

      // maven_transactions is the one table BOTH sides write: ngpay-approve
      // executes a decision on the provider, verifies it with a read-back, and
      // writes the new status here immediately — but the old project's
      // collector has not re-polled Maven yet, so its row still says PENDING.
      // A blind upsert then reverted our just-executed decision, and the row
      // only became correct again 14–27 minutes later when the old collector
      // finally caught up. approved_by survived (it is stripped above) while
      // status and last_status_change were rolled back, which is exactly the
      // fingerprint seen on tx_id 138453864: local last_status_change fell
      // back to 02:46:05 for a decision executed at 02:50:00, while a live
      // read of the provider said DECLINED.
      //
      // Never let an incoming row move a transaction's status backwards in
      // time. Rows we already hold with a newer last_status_change keep their
      // status columns; everything else about them still refreshes.
      let payload = rows as Record<string, unknown>[]
      // Operator annotations are local panel data. The old project continues
      // to send the original SMS row through the overlap window, so a blind
      // upsert would erase an edited withdrawal name/note seconds after save.
      if (table === 'inbound_sms') {
        const ids = payload.map((r) => r.id as number)
        const localMeta = new Map<number, Record<string, unknown>>()
        const LOOKUP_CHUNK = 200
        for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
          const { data: locals, error: localErr } = await db.from('inbound_sms')
            .select('id, sender_name, notes, consumed_by_tx_id, matched_transaction_id, matched, match_status, auto_match_score, processed_at').in('id', ids.slice(i, i + LOOKUP_CHUNK))
          if (localErr) throw new Error(`sms metadata guard lookup: ${localErr.message}`)
          for (const local of locals ?? []) localMeta.set(local.id, local)
        }
        payload = payload.map((row) => {
          const local = localMeta.get(row.id as number)
          if (!local) return row
          const preservedLink = local.consumed_by_tx_id != null ? {
            consumed_by_tx_id: local.consumed_by_tx_id,
            matched_transaction_id: local.matched_transaction_id,
            matched: local.matched,
            match_status: local.match_status,
            auto_match_score: local.auto_match_score,
            processed_at: local.processed_at,
          } : {}
          return {
            ...row,
            sender_name: local.sender_name ?? row.sender_name ?? null,
            notes: local.notes ?? row.notes ?? null,
            ...preservedLink,
          }
        })
      }
      if (table === 'maven_payout_transactions') {
        const ids = payload.map((r) => r.maven_id as number)
        const matchedSms = new Map<number, number>()
        const statusOverrides = new Map<number, { status: unknown; manual_reopened_at: unknown; manual_reopened_by: unknown }>()
        const LOOKUP_CHUNK = 200
        for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
          const { data: locals, error: localErr } = await db.from('maven_payout_transactions')
            .select('maven_id, matched_sms_id, status, manual_status_override, manual_reopened_at, manual_reopened_by').in('maven_id', ids.slice(i, i + LOOKUP_CHUNK))
          if (localErr) throw new Error(`payout SMS-link guard lookup: ${localErr.message}`)
          for (const local of locals ?? []) {
            if (local.matched_sms_id != null) matchedSms.set(local.maven_id, local.matched_sms_id)
            if (local.manual_status_override) statusOverrides.set(local.maven_id, local)
          }
        }
        payload = payload.map((row) => {
          const held = statusOverrides.get(row.maven_id as number)
          const isReopenedReview = held?.manual_reopened_at != null
          const incomingStillPending = /^pending$/i.test(String(row.status ?? ''))
          const preserveHeldStatus = Boolean(held && (isReopenedReview || incomingStillPending))
          return {
            ...row,
            matched_sms_id: matchedSms.get(row.maven_id as number) ?? row.matched_sms_id ?? null,
            ...(preserveHeldStatus
              ? { status: held?.status, manual_status_override: true, manual_reopened_at: held?.manual_reopened_at, manual_reopened_by: held?.manual_reopened_by }
              : held ? { manual_status_override: false, manual_reopened_at: null, manual_reopened_by: null } : {}),
          }
        })
      }
      if (table === 'maven_transactions') {
        const localTs = new Map<number, number>()
        // The guard needs our CURRENT values, not just the timestamp: a blocked
        // row is rewritten with them rather than having the keys removed.
        const localHold = new Map<number, { status: unknown; last_status_change: unknown }>()
        // A full page is 1000 ids, and PostgREST puts .in() in the query
        // string — one request would build a ~10KB URL and be rejected. It
        // must also THROW on failure rather than fall through: an empty map
        // silently disables the guard, which is worse than not having it.
        const LOOKUP_CHUNK = 200
        const ids = payload.map((r) => r.tx_id as number)
        for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
          const { data: locals, error: localErr } = await db
            .from('maven_transactions')
            .select('tx_id, status, last_status_change')
            .in('tx_id', ids.slice(i, i + LOOKUP_CHUNK))
          if (localErr) throw new Error(`status guard lookup: ${localErr.message}`)
          for (const l of locals ?? []) {
            localTs.set(l.tx_id, l.last_status_change ? Date.parse(l.last_status_change) : 0)
            localHold.set(l.tx_id, { status: l.status, last_status_change: l.last_status_change })
          }
        }
        payload = payload.map((r) => {
          const mine = localTs.get(r.tx_id as number)
          if (mine == null) return r // not held locally yet — a plain insert
          const raw = r.last_status_change
          const theirs = typeof raw === 'string' ? Date.parse(raw) : NaN
          // An incoming row with no usable timestamp cannot prove it is newer,
          // so it does not get to move a status we already hold.
          if (Number.isFinite(theirs) && theirs >= mine) return r
          // Rewrite the blocked columns with what we already hold instead of
          // deleting the keys. Deleting them made this array heterogeneous, and
          // PostgREST builds one bulk INSERT from the first object's columns —
          // a mixed-key batch is rejected outright (PGRST102), so a SINGLE row
          // needing the guard failed the whole updated-rows upsert. The error
          // was caught into the results object that nothing reads, so status
          // updates simply stopped arriving while new rows kept syncing through
          // the other pass. Same protection, homogeneous payload.
          const held = localHold.get(r.tx_id as number)
          return { ...r, status: held?.status, last_status_change: held?.last_status_change }
        })
      }

      const { error: upErr } = await db.from(table).upsert(payload, { onConflict: pk })
      if (upErr) throw new Error(`upsert: ${upErr.message}`)
      upserted += rows.length
      if (rows.length < PAGE) break
      offset += rows.length
    }
    return upserted
  }

  async function watermark(table: string, col: string, overlapMs: number): Promise<string> {
    const { data: maxRow, error: maxErr } = await db
      .from(table)
      .select(col)
      .order(col, { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (maxErr) throw new Error(maxErr.message)
    const maxTs = (maxRow as Record<string, string> | null)?.[col]
    return maxTs
      ? new Date(new Date(maxTs).getTime() - overlapMs).toISOString()
      : '1970-01-01T00:00:00Z'
  }

  for (const { table, pk, ts, updatedTs } of GROWING) {
    try {
      const since = await watermark(table, ts, OVERLAP_MS)
      results[table] = await pullSince(table, pk, ts, since)
    } catch (e) {
      // Recorded AND logged. These were only ever written into the returned
      // results object, which no caller inspects — so a pass could fail every
      // run for a day without anyone seeing it. That is exactly what happened.
      results[table] = `error: ${(e as Error).message}`
      console.error(`deltaSync ${table} (new rows) failed:`, e)
    }

    if (!updatedTs) continue
    // Only transaction tables need live update polling. Configuration/CRM
    // updates stay on the full cadence to keep the fast path cheap.
    if (mode === 'fast' && !['maven_transactions', 'maven_payout_transactions'].includes(table)) continue
    try {
      const since = mode === 'fast'
        ? new Date(Date.now() - FAST_UPDATED_LOOKBACK_MS).toISOString()
        : await watermark(table, updatedTs, UPDATED_OVERLAP_MS)
      results[`${table}:updated`] = await pullSince(table, pk, updatedTs, since)
    } catch (e) {
      results[`${table}:updated`] = `error: ${(e as Error).message}`
      console.error(`deltaSync ${table} (status updates) failed:`, e)
    }
  }

  // Run a bounded exact-reference matcher after every provider pull. This only
  // links evidence; it never approves/declines or calls a provider. The full
  // pass scans farther back as a repair net.
  {
    try {
      const repair = await repairPaidSmsMatches(true, mode === 'full' ? 1000 : 150)
      results['sms_exact_matches'] = repair.linked
      console.info('exact SMS matcher completed', {
        scannedSms: repair.scannedSms,
        scannedTransactions: repair.scannedTransactions,
        eligible: repair.eligible,
        linked: repair.linked,
        skippedAmbiguous: repair.skippedAmbiguous,
        skippedAlreadyAssigned: repair.skippedAlreadyAssigned,
        diagnosticCounts: Object.entries(repair.diagnostics).map(([key, value]) => `${key}=${value}`).join(','),
        errors: repair.errors.length,
      })
      if (repair.errors.length) console.error('paid SMS repair partial errors:', repair.errors)
    } catch (e) {
      results['sms_exact_matches'] = `error: ${(e as Error).message}`
      console.error('exact SMS matcher failed:', e)
    }
  }

  try {
    const payoutSms = await autoLinkWithdrawalSms(mode === 'full' ? 1000 : 150)
    results['payout_sms_matches'] = payoutSms.linked
    console.info('withdrawal SMS → payout matcher completed', payoutSms)
  } catch (e) {
    results['payout_sms_matches'] = `error: ${(e as Error).message}`
    console.error('withdrawal SMS → payout matcher failed:', e)
  }

  try {
    const alerts = await produceRiskAlerts()
    results['risk_alerts_sent'] = alerts.sent
    console.info('risk alert producers completed', alerts)
    if (alerts.errors.length) console.error('risk alert producer partial errors:', alerts.errors)
  } catch (e) {
    results['risk_alerts_sent'] = `error: ${(e as Error).message}`
    console.error('risk alert producers failed:', e)
  }

  return results
}

function syncOnce(mode: 'fast' | 'full'): Promise<Record<string, number | string>> {
  if (activeSync) return activeSync
  activeSync = runSync(mode).finally(() => { activeSync = null })
  return activeSync
}

function resultOk(results: Record<string, number | string>): boolean {
  return !Object.values(results).some((value) => typeof value === 'string' && value.startsWith('error:'))
}

// Daily Vercel Cron.
deltaSyncRoutes.get('/delta-sync', async (c) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (!(await claimDistributedLease(240))) return c.json({ ok: true, skipped: 'distributed_lease' })
  const results = await syncOnce('full').catch((e) => ({ error: `error: ${(e as Error).message}` }))
  return c.json({ ok: resultOk(results), mode: 'full', results, at: new Date().toISOString() }, resultOk(results) ? 200 : 502)
})

// Piggyback trigger from the authed panel. Throttled per warm lambda; the
// overlap-window upsert keeps concurrent runs idempotent.
//
// Every authenticated caller runs ONLY the bounded fast pass. A previous
// version occasionally promoted this request to a full pass using in-memory
// timestamps, but Vercel instances do not share memory: several open panels
// therefore launched overlapping 24-hour pulls and SMS repair jobs. The cron
// endpoint above is the sole owner of full repair work.
// Measured before
// this split: a transaction reached the old project in ~75s (median) but took
// ~53 minutes (median) to reach ont27, because the only unattended sync was a
// daily cron and the in-panel pump was throttled to 60s.
deltaSyncRoutes.post('/delta-sync', async (c) => {
  const token = getCookie(c, ACCESS_COOKIE)
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims) return c.json({ error: 'unauthenticated' }, 401)

  const now = Date.now()
  const wantFast = now - lastFastRunAt >= FAST_THROTTLE_MS
  if (!wantFast) return c.json({ ok: true, skipped: 'throttled' })

  if (!(await claimDistributedLease(10))) return c.json({ ok: true, skipped: 'distributed_lease' })

  const mode = 'fast'
  lastFastRunAt = now
  const results = await syncOnce(mode).catch((e) => ({ error: `error: ${(e as Error).message}` }))
  const ok = resultOk(results)
  return c.json({ ok, mode, results, at: new Date().toISOString() }, ok ? 200 : 502)
})
