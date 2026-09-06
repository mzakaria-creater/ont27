import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { createClient } from '@supabase/supabase-js'
import { db } from './db.js'
import { ACCESS_COOKIE, verifyAccessToken } from './tokens.js'
import { repairPaidSmsMatches } from './smsMatcher.js'
import { produceRiskAlerts } from './riskAlerts.js'
import { autoLinkWithdrawalSms } from './payoutSmsMatcher.js'
import { oldDb } from './oldDb.js'

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
// The old auto-decline sweep was repaired at this instant. Never consume its
// historical backlog: those rows predate the repaired safeguards and require
// human review. Only fresh decisions created by the repaired sweep may cross
// into the live provider executor.
const AUTO_DECLINE_BRIDGE_CUTOFF = '2026-08-25T02:17:31.579426Z'
let lastFastRunAt = 0
// Fast provider pulls must never wait behind the full repair pass. They touch
// the same idempotent mirror with status/timestamp guards, so concurrent runs
// are safe and keep new Maven transactions visible while a full scan runs.
const activeSync: { fast: Promise<Record<string, number | string>> | null; full: Promise<Record<string, number | string>> | null } = { fast: null, full: null }

async function executeRecordedAutoDeclines(): Promise<{ executed: number; skipped: number; failed: number }> {
  const old = oldDb()
  const baseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!old || !baseUrl || !serviceKey) throw new Error('auto-decline bridge is not configured')

  const { data: jobs, error: jobsErr } = await old.from('browser_jobs')
    .select('id, tx_id, target_status, state, created_at')
    .eq('source', 'auto_trigger').eq('state', 'pending').eq('target_status', 'DECLINED')
    .gte('created_at', AUTO_DECLINE_BRIDGE_CUTOFF).order('created_at', { ascending: true }).limit(3)
  if (jobsErr) throw new Error(`auto-decline jobs: ${jobsErr.message}`)

  let executed = 0; let skipped = 0; let failed = 0
  for (const job of jobs ?? []) {
    // Claim atomically. Another warm lambda cannot execute the same job.
    const { data: claimed, error: claimErr } = await old.from('browser_jobs').update({
      state: 'running', locked_at: new Date().toISOString(), locked_by: 'panel-v2-ngpay-bridge',
      attempts: 1, updated_at: new Date().toISOString(),
    }).eq('id', job.id).eq('state', 'pending').select('id').maybeSingle()
    if (claimErr || !claimed) { skipped++; continue }

    try {
      const [{ data: review }, { data: tx }] = await Promise.all([
        old.from('review_queue').select('decision, matched_sms_id, decision_reason').eq('tx_id', job.tx_id).maybeSingle(),
        old.from('maven_transactions').select('tx_id, status, amount, created_utc, to_account_number, gateway').eq('tx_id', job.tx_id).maybeSingle(),
      ])
      if (!review || review.decision !== 'auto_declined' || review.matched_sms_id != null || !tx || tx.status !== 'PENDING' || tx.gateway !== 'NagupayP2P') {
        throw new Error('safety revalidation refused: decision/transaction is no longer eligible')
      }

      // A late SMS can arrive after the five-minute sweep but before provider
      // execution. Any unconsumed deposit evidence with the same wallet,
      // amount and ±5-minute window cancels automation and returns the job to
      // manual review; it must never be declined underneath fresh evidence.
      const createdMs = Date.parse(tx.created_utc)
      if (!Number.isFinite(createdMs)) throw new Error('transaction has no valid created_utc')
      const { count: lateEvidence, error: smsErr } = await old.from('inbound_sms').select('id', { count: 'exact', head: true })
        .eq('sms_category', 'deposit').eq('amount', tx.amount).eq('receiver_number', tx.to_account_number)
        .is('consumed_by_tx_id', null)
        .gte('received_at', new Date(createdMs - 5 * 60_000).toISOString())
        .lte('received_at', new Date(createdMs + 5 * 60_000).toISOString())
      if (smsErr) throw new Error(`late-SMS guard failed: ${smsErr.message}`)
      if ((lateEvidence ?? 0) > 0) {
        await old.from('browser_jobs').update({ state: 'cancelled', last_error: 'Late matching SMS evidence arrived; manual review required', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', job.id)
        await old.from('review_queue').update({ decision: 'pending_review', decision_reason: 'Late matching SMS evidence arrived after auto-decline evaluation — manual review required', decided_at: null }).eq('tx_id', job.tx_id)
        skipped++
        continue
      }

      const response = await fetch(`${baseUrl}/functions/v1/ngpay-approve`, {
        method: 'POST', signal: AbortSignal.timeout(45_000),
        headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'content-type': 'application/json' },
        body: JSON.stringify({ tx_id: Number(job.tx_id), decision: 'DECLINED', actor_name: 'auto_decline_5m', remark: review.decision_reason ?? 'No clean SMS match after 5 minutes' }),
      })
      const result = await response.json().catch(() => ({ error: 'worker_invalid_response' })) as Record<string, unknown>
      if (!response.ok || result.executed_on_provider !== true) throw new Error(String(result.error ?? `ngpay-approve HTTP ${response.status}`))

      await old.from('browser_jobs').update({ state: 'completed', completed_at: new Date().toISOString(), maven_before_status: result.before_status ?? null, maven_after_status: result.after_status ?? 'DECLINED', updated_at: new Date().toISOString(), last_error: null }).eq('id', job.id)
      executed++
    } catch (error) {
      failed++
      await old.from('browser_jobs').update({ state: 'pending', last_error: error instanceof Error ? error.message.slice(0, 500) : 'execution failed', next_run_at: new Date(Date.now() + 60_000).toISOString(), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).eq('id', job.id)
    }
  }
  return { executed, skipped, failed }
}

async function claimDistributedLease(ttlSeconds: number, leaseName = 'provider_delta_sync'): Promise<boolean> {
  const { data, error } = await db.rpc('claim_provider_sync_lease', {
    p_lease_name: leaseName, p_ttl_seconds: ttlSeconds,
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
          // PayFuture exposes the sub-merchant as reference5/SiteId on its
          // legacy payloads rather than in the normalized column. Preserve
          // that provider identifier so new mirror rows are immediately
          // filterable and assignable in the panel.
          if (!r.sub_merchant && r.master_merchant?.toString().toLowerCase() === 'payfuture') {
            const raw = r.raw
            const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
            const candidate = payload && ['sub_merchant', 'subMerchant', 'subMerchantName', 'SubMerchantName', 'reference5', 'reference4', 'SiteId', 'siteId']
              .map((key) => payload[key]).find((value) => typeof value === 'string' && value.trim() && value.trim() !== 'merchant_payment_detail')
            if (typeof candidate === 'string') r.sub_merchant = candidate.trim()
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

        // A status change observed in Maven is a provider-side action. Keep
        // it separate from review_queue/browser_jobs: those rows describe an
        // automation decision or an agent execution attempt, while this is
        // the fact that Maven actually applied a change. The timestamp guard
        // above also makes this idempotent across the overlap window.
        const providerActions = payload.filter((r) => {
          const txId = Number(r.tx_id)
          const held = localHold.get(txId)
          if (!held || held.status === r.status) return false
          const theirs = typeof r.last_status_change === 'string' ? Date.parse(r.last_status_change) : NaN
          const mine = localTs.get(txId) ?? 0
          return Number.isFinite(theirs) && theirs > mine
        })

        if (providerActions.length > 0) {
          const { error: auditErr } = await db.from('audit_log').insert(providerActions.map((r) => ({
            actor_type: 'system',
            actor_name: 'Maven',
            action: 'deposit.maven_action_applied',
            entity: 'maven_transactions',
            entity_id: String(r.tx_id),
            before: { status: localHold.get(Number(r.tx_id))?.status ?? null },
            after: {
              status: r.status,
              source: 'maven_dashboard',
              provider_modified_at: r.modified_utc ?? r.last_status_change ?? null,
            },
          })))
          if (auditErr) console.error('Maven provider action audit failed', { error: auditErr.message, count: providerActions.length })
        }
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

  // Legacy auto-decline execution is disabled during the v2 cutover. The old
  // bridge reads the legacy project's queue and could apply a decline before
  // the v2 any-wallet-SMS guard has reviewed the evidence. Keep it opt-in for
  // emergency rollback only; normal production runs leave these transactions
  // pending until the v2 worker owns the queue.
  if (process.env.ENABLE_LEGACY_AUTO_DECLINE_BRIDGE === 'true') {
    try {
      const autoDeclines = await executeRecordedAutoDeclines()
      results['auto_declines_executed'] = autoDeclines.executed
      results['auto_declines_failed'] = autoDeclines.failed
      console.info('recorded legacy auto-decline bridge completed', autoDeclines)
    } catch (e) {
      results['auto_declines_executed'] = `error: ${(e as Error).message}`
      console.error('recorded legacy auto-decline bridge failed:', e)
    }
  } else {
    results['auto_declines_executed'] = 0
    console.info('legacy auto-decline bridge disabled during v2 cutover')
  }

  return results
}

function syncOnce(mode: 'fast' | 'full'): Promise<Record<string, number | string>> {
  if (activeSync[mode]) return activeSync[mode]!
  activeSync[mode] = runSync(mode).finally(() => { activeSync[mode] = null })
  return activeSync[mode]!
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
  if (!(await claimDistributedLease(240, 'provider_delta_sync_full'))) return c.json({ ok: true, skipped: 'distributed_lease' })
  const results = await syncOnce('full').catch((e) => ({ error: `error: ${(e as Error).message}` }))
  return c.json({ ok: resultOk(results), mode: 'full', results, at: new Date().toISOString() }, resultOk(results) ? 200 : 502)
})

// v2 owns the decline sweep after the legacy bridge cutover. The SQL function
// contains the any-wallet ±10 minute evidence guard; this endpoint only
// invokes it under the cron secret and a short distributed lease.
deltaSyncRoutes.get('/auto-decline', async (c) => {
  const secret = process.env.CRON_SECRET
  if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ error: 'unauthorized' }, 401)
  if (!(await claimDistributedLease(50, 'provider_auto_decline_v2'))) return c.json({ ok: true, skipped: 'distributed_lease' })
  const { data: settings, error: settingsError } = await db.from('automation_settings').select('automation_enabled').eq('id', 1).maybeSingle()
  if (settingsError) return c.json({ ok: false, error: settingsError.message }, 502)
  if (settings?.automation_enabled !== true) return c.json({ ok: true, skipped: 'automation_disabled', at: new Date().toISOString() })
  const { data, error } = await db.rpc('sweep_auto_decline_stale_unmatched', { p_grace_minutes: null, p_score_threshold: null })
  if (error) return c.json({ ok: false, error: error.message }, 502)
  return c.json({ ok: true, results: data ?? [] , at: new Date().toISOString() })
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

  // Keep the fast browser pump independent from the long full-repair lease.
  // The full cron can legitimately hold its lease for several minutes while
  // walking status changes; sharing that lease made every fast request return
  // `distributed_lease` and left fresh provider rows invisible until cron ran.
  if (!(await claimDistributedLease(10, 'provider_delta_sync_fast'))) return c.json({ ok: true, skipped: 'distributed_lease' })

  const mode = 'fast'
  lastFastRunAt = now
  const results = await syncOnce(mode).catch((e) => ({ error: `error: ${(e as Error).message}` }))
  const ok = resultOk(results)
  return c.json({ ok, mode, results, at: new Date().toISOString() }, ok ? 200 : 502)
})
