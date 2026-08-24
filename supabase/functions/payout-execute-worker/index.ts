import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ============================================================================
// payout-execute-worker — REAL provider execution for payout decisions.
//
// The portal's own script posts multipart/form-data to
//   /Supplier/Transactions/UpdateP2PPayoutTransaction
// with Id, status, utrNumbder (their spelling, kept exactly), remark,
// chkTestTxn and an optional ImageUpload. That is what this sends.
//
// Order of operations, log-first, same as the deposit worker:
//   1. insert payout_decision_log with executed_on_provider = false
//   2. guards: kill switch, amount cap, UTR present, payout still pending
//   3. POST the update
//   4. verify by re-reading the payout LIST (GetPayoutTransactionDetails
//      returns 500 for real ids, so the list is the only read-back available)
//   5. flip executed_on_provider only when the provider's own status matches
//
// A payout moves money OUT and cannot be undone by us, so every refusal is
// explicit and every failure leaves executed_on_provider = false with the
// reason written down. Nothing here ever reports success it did not verify.
// ============================================================================

const DEFAULT_BASE = "https://bo.maven-consulting.co/Supplier";
const STATUS_MAP: Record<string, string> = {
  APPROVED: "PAID",
  DECLINED: "DECLINED",
};

function pc(v: string | null): string {
  if (!v) return "";
  return v
    .split(/,(?=\s*[^;,=]+=[^;,]+)/g)
    .flatMap((c) => c.split("\n"))
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function login(u: string, p: string, base: string): Promise<string> {
  const lp = await fetch(`${base}/Login/PostV2`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Username: u, Password: p }),
  });
  const cookie = pc(lp.headers.get("set-cookie"));
  if (!cookie || lp.status >= 400)
    throw new Error(`provider login failed (${lp.status})`);
  return cookie;
}

// The payout list is the only working read for a single payout's status.
async function readPayoutStatus(
  cookie: string,
  base: string,
  mavenId: number,
): Promise<string | null> {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date, time: string) =>
    `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${time}`;
  const body = new URLSearchParams({
    draw: "1",
    start: "0",
    length: "200",
    "search[value]": String(mavenId),
    "search[regex]": "false",
    "order[0][column]": "26",
    "order[0][dir]": "desc",
    StartCreatedDate: fmt(new Date(Date.now() - 7 * 86400000), "00:00:00"),
    EndCreatedDate: fmt(new Date(), "23:59:59"),
  }).toString();
  const r = await fetch(`${base}/Transactions/GetP2PPayoutTransactions`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      accept: "application/json",
    },
    body,
  });
  if (!r.ok) throw new Error(`payout list HTTP ${r.status}`);
  const data = await r.json();
  const row = (data.data ?? []).find(
    (x: Record<string, unknown>) => Number(x.ID) === mavenId,
  );
  return row ? String(row.Status ?? "") : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const token = (req.headers.get("authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token) return json({ error: "unauthorized" }, 401);
    const probe = createClient(supabaseUrl, token, {
      auth: { persistSession: false },
    });
    if ((await probe.from("panel_users").select("id").limit(1)).error)
      return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const {
      maven_id,
      decision,
      actor_name,
      utr_number,
      remark,
      proof_url,
      mode,
    } = body as {
      maven_id?: number;
      decision?: "APPROVED" | "DECLINED";
      actor_name?: string;
      utr_number?: string;
      remark?: string;
      proof_url?: string;
      mode?: "manual" | "auto";
    };

    if (!maven_id) return json({ error: "maven_id is required" }, 400);
    if (!decision || !STATUS_MAP[decision])
      return json({ error: "decision must be APPROVED or DECLINED" }, 400);
    if (!actor_name) return json({ error: "actor_name is required" }, 400);

    const { data: payout } = await sb
      .from("maven_payout_transactions")
      .select("maven_id, ontarget_ref, status, amount")
      .eq("maven_id", maven_id)
      .maybeSingle();
    if (!payout)
      return json({ error: `No payout for maven_id ${maven_id}` }, 404);

    const wantAuto = mode === "auto";

    // 1. Log first, always, whichever mode.
    const { data: logRow, error: logErr } = await sb
      .from("payout_decision_log")
      .insert({
        maven_id,
        ontarget_ref: payout.ontarget_ref,
        decision,
        actor_name,
        proof_url: proof_url ?? null,
        remark: remark ?? null,
        utr_number: utr_number ?? null,
        execution_mode: wantAuto ? "auto" : "manual",
        db_status_before: payout.status,
        executed_on_provider: false,
      })
      .select()
      .single();
    if (logErr)
      return json(
        { error: `Audit log write failed, aborting: ${logErr.message}` },
        500,
      );

    const fail = async (msg: string, status = 400) => {
      await sb
        .from("payout_decision_log")
        .update({ execution_error: msg })
        .eq("id", logRow.id);
      return json(
        {
          ok: false,
          error: msg,
          audit_log_id: logRow.id,
          executed_on_provider: false,
        },
        status,
      );
    };

    if (!wantAuto) {
      return json({
        ok: true,
        mode: "manual",
        audit_log_id: logRow.id,
        executed_on_provider: false,
        note: "Decision recorded. Execute it on the provider portal yourself — this system did not.",
      });
    }

    // 2. Guards, before anything leaves.
    const { data: settings } = await sb
      .from("payout_execution_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (!settings?.auto_execute_enabled) {
      return await fail(
        "Automatic payout execution is switched off. The decision is recorded; move the money on the portal.",
        409,
      );
    }
    if (
      settings.max_auto_amount != null &&
      Number(payout.amount) > Number(settings.max_auto_amount)
    ) {
      return await fail(
        `Amount ${payout.amount} is above the auto-execution cap of ${settings.max_auto_amount}. Use the manual path.`,
        409,
      );
    }
    if (decision === "APPROVED" && (!utr_number || !utr_number.trim())) {
      return await fail(
        "utr_number is required — the provider portal refuses the update without one.",
        400,
      );
    }

    const g = async (n: string, owner = "global") =>
      (
        await sb
          .from("maven_runtime_config")
          .select("value")
          .eq("name", n)
          .eq("owner_name", owner)
          .maybeSingle()
      ).data?.value;
    const username =
      (await g("MAVEN_COLLECTOR_USERNAME")) || (await g("MAVEN_USERNAME"));
    const password =
      (await g("MAVEN_COLLECTOR_PASSWORD")) || (await g("MAVEN_PASSWORD"));
    const base = (await g("MAVEN_COLLECTOR_BASE")) || DEFAULT_BASE;
    if (!username || !password)
      return await fail(
        "Missing provider credentials in maven_runtime_config",
        500,
      );

    let beforeStatus: string | null = null;
    let afterStatus: string | null = null;
    try {
      const cookie = await login(username, password, base);

      // Refuse to touch anything the provider does not still show as pending.
      beforeStatus = await readPayoutStatus(cookie, base, Number(maven_id));
      await sb
        .from("payout_decision_log")
        .update({ provider_raw_status_at_decision: beforeStatus })
        .eq("id", logRow.id);
      if (beforeStatus === null)
        return await fail(
          "Payout not found in the provider list — refusing to execute blind.",
          409,
        );
      const target = STATUS_MAP[decision];
      if (beforeStatus.toUpperCase() === target) {
        afterStatus = beforeStatus; // already there; nothing to send
      } else if (!/pending|process/i.test(beforeStatus)) {
        return await fail(
          `Provider status is ${beforeStatus}, not pending — refusing (no reversals through this worker).`,
          409,
        );
      } else {
        const form = new FormData();
        form.append("Id", String(maven_id));
        form.append("status", target);
        form.append("utrNumbder", utr_number?.trim() ?? ""); // the portal's own spelling
        form.append("remark", remark ?? "");
        form.append("chkTestTxn", "false");
        if (proof_url) {
          try {
            const img = await fetch(proof_url);
            if (img.ok) {
              const blob = await img.blob();
              form.append("ImageUpload", blob, `proof-${maven_id}.jpg`);
            }
          } catch {
            /* the proof is a nice-to-have; the UTR is what the portal requires */
          }
        }

        const r = await fetch(
          `${base}/Transactions/UpdateP2PPayoutTransaction`,
          {
            method: "POST",
            headers: {
              cookie,
              "X-Requested-With": "XMLHttpRequest",
              referer: `${base}/Transactions/GetP2PPayoutTransactionList`,
              origin: "https://bo.maven-consulting.co",
            },
            body: form,
          },
        );
        const text = await r.text();
        if (!r.ok)
          return await fail(
            `UpdateP2PPayoutTransaction HTTP ${r.status}: ${text.slice(0, 200)}`,
            502,
          );

        // 4. Verify against the provider's own view before claiming anything.
        await new Promise((res) => setTimeout(res, 2500));
        afterStatus = await readPayoutStatus(cookie, base, Number(maven_id));
        if (!afterStatus || afterStatus.toUpperCase() !== target) {
          return await fail(
            `Update sent but verify failed: expected ${target}, provider says ${afterStatus ?? "unknown"}`,
            502,
          );
        }
      }
    } catch (e) {
      return await fail(
        e instanceof Error ? e.message : "provider execution failed",
        502,
      );
    }

    // 5. Verified. Only now is it true.
    await sb
      .from("payout_decision_log")
      .update({
        executed_on_provider: true,
        provider_status_after: afterStatus,
      })
      .eq("id", logRow.id);

    const nowIso = new Date().toISOString();
    const { error: updErr } = await sb
      .from("maven_payout_transactions")
      // Provider calls a successful payout PAID; the local Maven mirror uses
      // APPROVED. Hold the verified local result until the source replica has
      // caught up, otherwise a stale PENDING sync immediately reverts the UI.
      .update({
        status: decision,
        updated_utc: nowIso,
        manual_status_override: true,
        manual_reopened_at: null,
        manual_reopened_by: null,
      })
      .eq("maven_id", maven_id);

    return json({
      ok: true,
      mode: "auto",
      maven_id,
      decision,
      before_status: beforeStatus,
      after_status: afterStatus,
      audit_log_id: logRow.id,
      executed_on_provider: true,
      warning: updErr
        ? `provider execution succeeded but local row update failed: ${updErr.message}`
        : undefined,
    });
  } catch (err) {
    console.error("payout-execute-worker error:", err);
    return json(
      { error: err instanceof Error ? err.message : "Internal error" },
      500,
    );
  }
});
