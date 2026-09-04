import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { fmtDay, listTransactions, login, sha256, toDbRow } from "../_shared/maven.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const dayWindows = (from: Date, to: Date) => { const out: Array<[string, string]> = []; for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) { const end = new Date(d); end.setUTCDate(end.getUTCDate() + 1); out.push([fmtDay(d, "00:00:00"), fmtDay(end, "23:59:59")]); } return out; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  const started = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const now = new Date();
    const from = body.from ? new Date(body.from) : new Date(now.getTime() - 48 * 3600_000);
    const to = body.to ? new Date(body.to) : now;
    const user = (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_COLLECTOR_USERNAME").eq("owner_name", "global").maybeSingle()).data?.value ?? (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_USERNAME").eq("owner_name", "global").maybeSingle()).data?.value;
    const pass = (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_COLLECTOR_PASSWORD").eq("owner_name", "global").maybeSingle()).data?.value ?? (await sb.from("maven_runtime_config").select("value").eq("name", "MAVEN_PASSWORD").eq("owner_name", "global").maybeSingle()).data?.value;
    if (!user || !pass) return json({ ok: false, error: "Missing Maven credentials in maven_runtime_config" }, 500);
    const cookie = await login(user, pass, "Supplier");
    const providerRows: any[] = [];
    for (const [windowFrom, windowTo] of dayWindows(from, to)) {
      let offset = 0;
      let fetchedForWindow = 0;
      let expectedForWindow = 0;
      while (true) {
        const page = await listTransactions(cookie, offset, windowFrom, windowTo);
        expectedForWindow = Math.max(expectedForWindow, page.total);
        fetchedForWindow += page.rows.length;
        providerRows.push(...page.rows);
        if (page.rows.length < 100) break;
        offset += 100;
      }
      if (expectedForWindow > 0 && fetchedForWindow !== expectedForWindow) {
        throw new Error(`Maven completeness gap for ${windowFrom}: fetched ${fetchedForWindow}, expected ${expectedForWindow}`);
      }
    }
    const mapped = (await Promise.all(providerRows.map(async (r) => { const row = toDbRow(r); return row ? { ...row, row_hash: await sha256(r) } : null; }))).filter(Boolean) as any[];
    const ids = mapped.map((r) => r.tx_id);
    const local = new Map<number, any>();
    for (let i = 0; i < ids.length; i += 500) { const { data } = await sb.from("maven_transactions").select("tx_id,status,row_hash,amount,merchant").in("tx_id", ids.slice(i, i + 500)); for (const row of data ?? []) local.set(Number(row.tx_id), row); }
    let inserted = 0, updated = 0, alerts = 0;
    for (const row of mapped) {
      const old = local.get(row.tx_id);
      if (!old) { const { error } = await sb.from("maven_transactions").insert({ ...row, first_seen_at: row.created_utc ? new Date(`${row.created_utc}Z`).toISOString() : new Date().toISOString(), last_seen_at: new Date().toISOString(), last_status_change: new Date().toISOString(), paid_source: row.status === "PAID" ? "reconciliation" : null, reconciled_from_provider: true }); if (!error) inserted++; continue; }
      if (old.row_hash === row.row_hash) continue;
      const patch: Record<string, unknown> = { ...row, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(), reconciled_from_provider: true };
      if (old.status === "PAID" && row.status !== "PAID") { patch.needs_review = true; alerts++; }
      if (old.status !== row.status) { patch.last_status_change = new Date().toISOString(); patch.paid_source = row.status === "PAID" ? "reconciliation" : null; await sb.from("maven_transaction_history").insert({ tx_id: row.tx_id, old_status: old.status, new_status: row.status, source: "reconciliation" }).select("id").maybeSingle(); await sb.from("audit_log").insert({ entity: "maven_transactions", entity_id: String(row.tx_id), action: "deposit.status_reconciled_from_provider", actor_name: "maven-reconcile-final-status", before: { status: old.status }, after: { status: row.status } }); }
      const { error } = await sb.from("maven_transactions").update(patch).eq("tx_id", row.tx_id); if (!error) updated++;
    }
    await sb.from("maven_reconcile_runs").insert({ merchant: null, window_start: from.toISOString(), window_end: to.toISOString(), rows_provider: mapped.length, rows_local: local.size, inserted, updated, alerts, duration_ms: Date.now() - started });
    return json({ ok: true, window: { from: from.toISOString(), to: to.toISOString() }, rows_provider: mapped.length, rows_local: local.size, inserted, updated, alerts, duration_ms: Date.now() - started });
  } catch (error) { await sb.from("maven_reconcile_runs").insert({ window_start: new Date(Date.now() - 48 * 3600_000).toISOString(), window_end: new Date().toISOString(), error: String(error), duration_ms: Date.now() - started }); return json({ ok: false, error: String(error) }, 500); }
});
