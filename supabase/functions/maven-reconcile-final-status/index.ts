import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { fmtDay, listTransactions, login, sha256, toDbRow } from "../_shared/maven.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LIVE_OVERLAP_MS = 15 * 60_000;
const REPAIR_WINDOW_MS = 48 * 3600_000;
const BACKFILL_CHUNK_MS = 15 * 60_000;
const MAVEN_REQUEST_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mavenStamp(value: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return fmtDay(value, `${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`);
}

function dateWindows(from: Date, to: Date): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); cursor < to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dayEnd = new Date(cursor);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    dayEnd.setUTCSeconds(dayEnd.getUTCSeconds() - 1);
    const start = cursor < from ? from : cursor;
    const end = dayEnd > to ? to : dayEnd;
    out.push([mavenStamp(start), mavenStamp(end)]);
  }
  return out;
}

function chunkWindows(from: Date, to: Date): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  for (let cursor = new Date(from); cursor < to;) {
    const end = new Date(Math.min(cursor.getTime() + BACKFILL_CHUNK_MS, to.getTime()));
    out.push([new Date(cursor), end]);
    cursor = end;
  }
  return out;
}

// Only provider-owned fields are written during reconciliation. Local SMS
// links, operator identity, manual notes and audit metadata are preserved.
const PROVIDER_FIELDS = [
  "guid", "status", "amount", "currency", "sender_name", "sender_number",
  "to_account_number", "to_account_name", "to_bank", "payment_method", "gateway",
  "merchant", "sub_merchant", "master_merchant", "agent_name", "country",
  "request_type", "response_message", "raw", "maven_raw_row", "proof_image_url",
  "receiving_wallet", "merchant_tx_reference", "email", "fees", "commission",
  "provider_commission", "created_utc", "modified_utc", "created_at_utc", "modified_at_utc",
] as const;

function providerPatch(row: Record<string, unknown>, now: string) {
  const patch: Record<string, unknown> = { tx_id: row.tx_id, last_seen_at: now, updated_at: now, reconciled_from_provider: true };
  for (const key of PROVIDER_FIELDS) if (key in row) patch[key] = row[key];
  return patch;
}

function amountSyncPatch(old: Record<string, any>, providerAmount: unknown) {
  if (old.provider_amount == null || providerAmount == null || providerAmount === "") return {};
  const provider = Number(old.provider_amount);
  const maven = Number(providerAmount);
  if (!Number.isFinite(provider) || !Number.isFinite(maven)) return {};
  if (provider !== maven) {
    return {
      amount_sync_status: "mismatch",
      amount_mismatch_reason: `Maven amount ${maven} differs from provider amount ${provider}`,
      settlement_blocked: true,
    };
  }
  return { amount_sync_status: "matched", amount_mismatch_reason: null, settlement_blocked: false };
}

async function fetchMapped(cookie: string, from: Date, to: Date, merchantFilter = "") {
  const providerRows: any[] = [];
  const windows = chunkWindows(from, to);
  for (const [chunkFrom, chunkTo] of windows) {
    let offset = 0;
    let fetched = 0;
    let expected = 0;
    const windowFrom = mavenStamp(chunkFrom);
    const windowTo = mavenStamp(chunkTo);
    while (true) {
      if (offset > 0) await sleep(MAVEN_REQUEST_DELAY_MS);
      const page = await listTransactions(cookie, offset, windowFrom, windowTo);
      expected = Math.max(expected, page.total);
      fetched += page.rows.length;
      providerRows.push(...page.rows);
      if (page.rows.length < 100) break;
      offset += page.rows.length;
    }
    if (expected > 0 && fetched !== expected) throw new Error(`Maven completeness gap for ${windowFrom}: fetched ${fetched}, expected ${expected}`);
    await sleep(MAVEN_REQUEST_DELAY_MS);
  }
  const mapped = (await Promise.all(providerRows.map(async (raw) => {
    const row = toDbRow(raw);
    return row ? { ...row, row_hash: await sha256(raw) } : null;
  }))).filter(Boolean) as Record<string, any>[];
  const filtered = merchantFilter
    ? mapped.filter((row) => String(row.merchant ?? "").toLowerCase() === merchantFilter.toLowerCase())
    : mapped;
  return [...new Map(filtered.map((row) => [Number(row.tx_id), row])).values()];
}

function createdAt(row: Record<string, unknown>, fallback: string) {
  const value = String(row.created_utc ?? "").trim();
  if (!value) return fallback;
  const parsed = new Date(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  const started = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let windowStart = new Date(Date.now() - LIVE_OVERLAP_MS);
  const windowEnd = new Date();
  try {
    const body = await req.json().catch(() => ({}));
    const isBackfill = body?.mode === "backfill";
    const dryRun = isBackfill && body?.dry_run === true;
    const merchantFilter = isBackfill ? String(body?.merchant ?? "").trim() : "";
    if (isBackfill && !merchantFilter) return json({ ok: false, error: "merchant_required" }, 400);
    const mode = body?.mode === "repair" ? "repair" : isBackfill ? "backfill" : "live";
    const from = body?.from ? new Date(body.from) : new Date(Date.now() - (mode === "repair" ? REPAIR_WINDOW_MS : LIVE_OVERLAP_MS));
    const to = body?.to ? new Date(body.to) : new Date();
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) return json({ ok: false, error: "invalid_window" }, 400);
    windowStart = from;

    const user = (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_COLLECTOR_USERNAME").eq("owner_name", "global").maybeSingle()).data?.value ?? (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_USERNAME").eq("owner_name", "global").maybeSingle()).data?.value;
    const pass = (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_COLLECTOR_PASSWORD").eq("owner_name", "global").maybeSingle()).data?.value ?? (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_PASSWORD").eq("owner_name", "global").maybeSingle()).data?.value;
    if (!user || !pass) return json({ ok: false, error: "Missing Maven credentials in maven_runtime_config" }, 500);

    const cookie = await login(user, pass, "Supplier");

    if (isBackfill) {
      const summaries: any[] = [];
      let totalProvider = 0;
      let totalLocal = 0;
      let totalInserted = 0;
      let totalStatusChanges = 0;
      let totalAmountChanges = 0;
      for (const [chunkFrom, chunkTo] of chunkWindows(from, to)) {
        const chunkStarted = Date.now();
        const mapped = await fetchMapped(cookie, chunkFrom, chunkTo, merchantFilter);
        const ids = mapped.map((row) => row.tx_id);
        const local = new Map<number, any>();
        for (let i = 0; i < ids.length; i += 500) {
          const { data, error } = await sb.from("maven_transactions").select("tx_id,status,row_hash,amount,provider_amount,amount_sync_status,amount_mismatch_reason,first_seen_at,approved_by,paid_source").in("tx_id", ids.slice(i, i + 500));
          if (error) throw new Error(`local lookup: ${error.message}`);
          for (const row of data ?? []) local.set(Number(row.tx_id), row);
        }
        const nowIso = new Date().toISOString();
        let inserted = 0;
        let updated = 0;
        let statusChanges = 0;
        let amountChanges = 0;
        let alerts = 0;
        for (const row of mapped) {
          const old = local.get(Number(row.tx_id));
          if (!old) {
            inserted++;
            continue;
          }
          const amountDiff = old.amount != null && Number(old.amount) !== Number(row.amount);
          const syncPatch = amountSyncPatch(old, row.amount);
          const statusDiff = old.status !== row.status;
          if (amountDiff) amountChanges++;
          if (statusDiff) statusChanges++;
          if (statusDiff && old.status === "PAID" && row.status !== "PAID") alerts++;
          if (!dryRun && (old.row_hash !== row.row_hash || Object.keys(syncPatch).length > 0)) {
            const patch: Record<string, any> = { ...providerPatch(row, nowIso), row_hash: row.row_hash, ...syncPatch };
            if (statusDiff) {
              patch.last_status_change = nowIso;
              patch.paid_source = row.status === "PAID" ? "reconciliation" : null;
              await sb.from("maven_transaction_history").insert({ tx_id: row.tx_id, old_status: old.status, new_status: row.status, source: "reconciliation", actor: "maven-reconcile-final-status", provider_modified_at: row.modified_utc ?? null });
              await sb.from("audit_log").insert({ entity: "maven_transactions", entity_id: String(row.tx_id), action: "deposit.status_reconciled_from_provider", actor_name: "maven-reconcile-final-status", before: { status: old.status }, after: { status: row.status } });
              if (old.status === "PAID" && row.status !== "PAID") { patch.needs_review = true; }
            }
            const { error } = await sb.from("maven_transactions").update(patch).eq("tx_id", row.tx_id);
            if (error) throw new Error(`update ${row.tx_id}: ${error.message}`);
            updated++;
          }
        }
        const summary = { window: { from: chunkFrom.toISOString(), to: chunkTo.toISOString() }, rows_provider: mapped.length, rows_local: local.size, would_insert: inserted, status_changes: statusChanges, amount_changes: amountChanges, inserted: dryRun ? 0 : inserted, updated: dryRun ? 0 : updated, alerts, duration_ms: Date.now() - chunkStarted };
        summaries.push(summary);
        totalProvider += mapped.length;
        totalLocal += local.size;
        totalInserted += inserted;
        totalStatusChanges += statusChanges;
        totalAmountChanges += amountChanges;
        if (!dryRun) {
          const { error } = await sb.from("maven_reconcile_runs").insert({ merchant: merchantFilter, window_start: chunkFrom.toISOString(), window_end: chunkTo.toISOString(), rows_provider: mapped.length, rows_local: local.size, inserted, updated, alerts, duration_ms: summary.duration_ms });
          if (error) throw new Error(`run log: ${error.message}`);
        }
      }
      return json({ ok: true, mode, dry_run: dryRun, merchant: merchantFilter, windows: summaries, totals: { rows_provider: totalProvider, rows_local: totalLocal, would_insert: totalInserted, status_changes: totalStatusChanges, amount_changes: totalAmountChanges }, duration_ms: Date.now() - started });
    }

    const providerRows: any[] = [];
    for (const [windowFrom, windowTo] of dateWindows(from, to)) {
      let offset = 0;
      let fetchedForWindow = 0;
      let expectedForWindow = 0;
      while (true) {
        const page = await listTransactions(cookie, offset, windowFrom, windowTo);
        expectedForWindow = Math.max(expectedForWindow, page.total);
        fetchedForWindow += page.rows.length;
        providerRows.push(...page.rows);
        if (page.rows.length < 100) break;
        offset += page.rows.length;
      }
      if (expectedForWindow > 0 && fetchedForWindow !== expectedForWindow) throw new Error(`Maven completeness gap for ${windowFrom}: fetched ${fetchedForWindow}, expected ${expectedForWindow}`);
    }

    const mapped = (await Promise.all(providerRows.map(async (raw) => {
      const row = toDbRow(raw);
      return row ? { ...row, row_hash: await sha256(raw) } : null;
    }))).filter(Boolean) as Record<string, any>[];
    const ids = mapped.map((row) => row.tx_id);
    const local = new Map<number, any>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await sb.from("maven_transactions").select("tx_id,status,row_hash,amount,provider_amount,amount_sync_status,amount_mismatch_reason,first_seen_at,approved_by,paid_source").in("tx_id", ids.slice(i, i + 500));
      if (error) throw new Error(`local lookup: ${error.message}`);
      for (const row of data ?? []) local.set(Number(row.tx_id), row);
    }

    const nowIso = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let alerts = 0;
    for (const row of mapped) {
      const old = local.get(Number(row.tx_id));
      if (!old) {
        const insertRow = { ...providerPatch(row, nowIso), first_seen_at: createdAt(row, nowIso), last_status_change: nowIso, paid_source: row.status === "PAID" ? "reconciliation" : null, row_hash: row.row_hash };
        const { error } = await sb.from("maven_transactions").insert(insertRow);
        if (error) throw new Error(`insert ${row.tx_id}: ${error.message}`);
        inserted++;
        continue;
      }
      const syncPatch = amountSyncPatch(old, row.amount);
      if (old.row_hash === row.row_hash && Object.keys(syncPatch).length === 0) { unchanged++; continue; }

      const patch: Record<string, any> = { ...providerPatch(row, nowIso), row_hash: row.row_hash, ...syncPatch };
      if (old.status !== row.status) {
        patch.last_status_change = nowIso;
        patch.paid_source = row.status === "PAID" ? "reconciliation" : null;
        if (old.status === "PAID" && row.status !== "PAID") { patch.needs_review = true; alerts++; }
        await sb.from("maven_transaction_history").insert({ tx_id: row.tx_id, old_status: old.status, new_status: row.status, source: "reconciliation", actor: "maven-reconcile-final-status", provider_modified_at: row.modified_utc ?? null });
        await sb.from("audit_log").insert({ entity: "maven_transactions", entity_id: String(row.tx_id), action: "deposit.status_reconciled_from_provider", actor_name: "maven-reconcile-final-status", before: { status: old.status }, after: { status: row.status } });
      }
      const { error } = await sb.from("maven_transactions").update(patch).eq("tx_id", row.tx_id);
      if (error) throw new Error(`update ${row.tx_id}: ${error.message}`);
      updated++;
    }

    const result = { ok: true, mode, window: { from: from.toISOString(), to: to.toISOString() }, rows_provider: mapped.length, rows_local: local.size, inserted, updated, unchanged, alerts, duration_ms: Date.now() - started };
    await sb.from("maven_reconcile_runs").insert({ merchant: null, window_start: from.toISOString(), window_end: to.toISOString(), rows_provider: mapped.length, rows_local: local.size, inserted, updated, alerts, duration_ms: result.duration_ms });
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sb.from("maven_reconcile_runs").insert({ window_start: windowStart.toISOString(), window_end: windowEnd.toISOString(), error: message.slice(0, 1000), duration_ms: Date.now() - started });
    return json({ ok: false, error: message }, 500);
  }
});
