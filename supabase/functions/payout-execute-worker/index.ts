import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { isAmbiguousProviderError } from "../_shared/ngpayExecution.ts";

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
const DEFAULT_OPERATOR_BASE = "https://bo.maven-consulting.co/Supplieroperator";
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;
const VERIFY_DELAY_MS = 2_500;
const STATUS_MAP: Record<string, string> = {
  APPROVED: "PAID",
  DECLINED: "DECLINED",
};

// Maven has returned both DECLINED and REJECTED for the same terminal
// provider state. Keep the raw value for audit/read-back, but compare a
// normalized value so a successful rejection is not reported as a failure.
function normalizedProviderStatus(value: string | null): string {
  const status = String(value ?? "").trim().toUpperCase();
  if (["PAID", "APPROVED", "SUCCESS", "COMPLETED"].includes(status)) return "PAID";
  if (["DECLINED", "REJECTED", "REJECT", "CANCELLED", "CANCELED"].includes(status)) return "DECLINED";
  if (["PENDING", "PROCESSING", "IN PROCESS", "IN_PROGRESS", "INPROGRESS"].includes(status)) return "PENDING";
  return status;
}

function pc(v: string | null): string {
  if (!v) return "";
  return v
    .split(/,(?=\s*[^;,=]+=[^;,]+)/g)
    .flatMap((c) => c.split("\n"))
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(u: string, p: string, base: string): Promise<string> {
  const lp = await fetch(`${base}/Login/PostV2`, {
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Username: u, Password: p }),
  });
  const cookie = pc(lp.headers.get("set-cookie"));
  const location = lp.headers.get("location") ?? "";
  if (!cookie || lp.status >= 400)
    throw new Error(`provider login failed (${lp.status})`);
  if (/resetpassword/i.test(location))
    throw new Error("provider login blocked: password reset required");
  if (lp.status !== 302 || /\/login|\/error/i.test(location))
    throw new Error(
      `provider login rejected (${lp.status} -> ${location || "no redirect"})`,
    );
  return cookie;
}

type Session = {
  cookie: string;
  base: string;
  account: "collector" | "operator";
  fallback_reason?: string;
};

async function openSession(config: Map<string, string>): Promise<Session> {
  const collectorUser =
    config.get("MAVEN_COLLECTOR_USERNAME") || config.get("MAVEN_USERNAME");
  const collectorPassword =
    config.get("MAVEN_COLLECTOR_PASSWORD") || config.get("MAVEN_PASSWORD");
  const collectorBase = config.get("MAVEN_COLLECTOR_BASE") || DEFAULT_BASE;
  const operatorUser = config.get("MAVEN_OPERATOR_USERNAME");
  const operatorPassword = config.get("MAVEN_OPERATOR_PASSWORD");
  const operatorBase = config.get("MAVEN_OPERATOR_BASE") || DEFAULT_OPERATOR_BASE;
  let firstError = "";

  if (collectorUser && collectorPassword) {
    try {
      return {
        cookie: await login(collectorUser, collectorPassword, collectorBase),
        base: collectorBase,
        account: "collector",
      };
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
  }
  if (operatorUser && operatorPassword) {
    return {
      cookie: await login(operatorUser, operatorPassword, operatorBase),
      base: operatorBase,
      account: "operator",
      fallback_reason: firstError || "collector credentials missing",
    };
  }
  throw new Error(firstError || "Missing provider credentials in maven_runtime_config");
}

async function openOperatorSession(config: Map<string, string>): Promise<Session> {
  const username = config.get("MAVEN_OPERATOR_USERNAME");
  const password = config.get("MAVEN_OPERATOR_PASSWORD");
  const base = config.get("MAVEN_OPERATOR_BASE") || DEFAULT_OPERATOR_BASE;
  if (!username || !password)
    throw new Error("Operator fallback credentials are not configured");
  return {
    cookie: await login(username, password, base),
    base,
    account: "operator",
    fallback_reason: "collector payout list failed after retry",
  };
}

// The payout list is the only working read for a single payout's status.
async function readPayoutStatus(
  cookie: string,
  base: string,
  mavenId: number,
  firstSeenAt?: string | null,
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
  const center = firstSeenAt ? new Date(firstSeenAt) : new Date();
  const startDate = new Date(center.getTime() - 2 * 86400000);
  const endDate = new Date(center.getTime() + 2 * 86400000);
  const body = new URLSearchParams({
    draw: "1",
    start: "0",
    length: "200",
    "search[value]": String(mavenId),
    "search[regex]": "false",
    "order[0][column]": "26",
    "order[0][dir]": "desc",
    StartCreatedDate: fmt(startDate, "00:00:00"),
    EndCreatedDate: fmt(endDate, "23:59:59"),
  }).toString();
  const r = await fetch(`${base}/Transactions/GetP2PPayoutTransactions`, {
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
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

async function readPayoutStatusWithRetry(
  cookie: string,
  base: string,
  mavenId: number,
  firstSeenAt?: string | null,
): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await readPayoutStatus(cookie, base, mavenId, firstSeenAt);
    } catch (error) {
      lastError = error;
      if (!isAmbiguousProviderError(error) || attempt === RETRY_ATTEMPTS) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          attempt > 1 ? `${message} (after ${attempt} attempts)` : message,
        );
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function submitPayoutUpdate(
  session: Session,
  mavenId: number,
  target: string,
  utrNumber: string | undefined,
  remark: string | undefined,
  proofUrl: string | undefined,
) {
  const form = new FormData();
  form.append("Id", String(mavenId));
  form.append("status", target);
  form.append("utrNumbder", utrNumber?.trim() ?? ""); // Maven's spelling.
  form.append("remark", remark ?? "");
  form.append("chkTestTxn", "false");
  if (proofUrl) {
    try {
      const image = await fetch(proofUrl, {
        signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      });
      if (image.ok) {
        const blob = await image.blob();
        form.append("ImageUpload", blob, `proof-${mavenId}.jpg`);
      }
    } catch {
      // The provider requires UTR; a proof-fetch failure is still recorded by
      // the caller and does not justify a second provider write.
    }
  }

  const response = await fetch(
    `${session.base}/Transactions/UpdateP2PPayoutTransaction`,
    {
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      method: "POST",
      headers: {
        cookie: session.cookie,
        "X-Requested-With": "XMLHttpRequest",
        referer: `${session.base}/Transactions/GetP2PPayoutTransactionList`,
        origin: "https://bo.maven-consulting.co",
      },
      body: form,
    },
  );
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Maven sometimes returns an empty success body.
  }
  if (!response.ok)
    throw new Error(
      `UpdateP2PPayoutTransaction HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  if (parsed?.success === false)
    throw new Error(
      `UpdateP2PPayoutTransaction rejected: ${String(parsed.message ?? text.slice(0, 200))}`,
    );
  if (typeof parsed?.redirect === "string")
    throw new Error(
      `UpdateP2PPayoutTransaction not authenticated (redirect ${parsed.redirect})`,
    );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  const requestStartedAt = performance.now();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const token = (req.headers.get("authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token || token !== serviceKey)
      return json({ error: "unauthorized" }, 401);

    const configNames = [
      "MAVEN_COLLECTOR_USERNAME",
      "MAVEN_USERNAME",
      "MAVEN_COLLECTOR_PASSWORD",
      "MAVEN_PASSWORD",
      "MAVEN_COLLECTOR_BASE",
      "MAVEN_OPERATOR_USERNAME",
      "MAVEN_OPERATOR_PASSWORD",
      "MAVEN_OPERATOR_BASE",
    ];
    const { data: configRows, error: configError } = await sb
      .from("maven_runtime_config")
      .select("name,value")
      .eq("owner_name", "global")
      .in("name", configNames);
    if (configError)
      return json(
        { error: `Provider configuration read failed: ${configError.message}` },
        500,
      );
    const config = new Map(
      (configRows ?? []).map((row: { name: string; value: string }) => [
        row.name,
        row.value,
      ]),
    );

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
      mode?: "manual" | "auto" | "batch_decline";
    };

    if (!maven_id) return json({ error: "maven_id is required" }, 400);
    if (!decision || !STATUS_MAP[decision])
      return json({ error: "decision must be APPROVED or DECLINED" }, 400);
    if (!actor_name) return json({ error: "actor_name is required" }, 400);

    const { data: payout } = await sb
      .from("maven_payout_transactions")
      .select("maven_id, ontarget_ref, status, amount, first_seen_at")
      .eq("maven_id", maven_id)
      .maybeSingle();
    if (!payout)
      return json({ error: `No payout for maven_id ${maven_id}` }, 404);

    const oneTimeBatchDecline = mode === "batch_decline";
    // A manual panel action is explicitly authorized by the logged-in
    // operator. It must still execute and verify on Maven when the automatic
    // payout switch is off; that switch only controls unattended automation.
    const manualExecution = mode === "manual";
    if (oneTimeBatchDecline && decision !== "DECLINED")
      return json({ error: "batch_decline_only" }, 400);
    const wantAuto = mode === "auto" || oneTimeBatchDecline;
    const shouldExecute = wantAuto || manualExecution;

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
        execution_mode: oneTimeBatchDecline ? "batch_decline" : wantAuto ? "auto" : "manual",
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

    if (!shouldExecute) {
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
    if (wantAuto && !oneTimeBatchDecline && !settings?.auto_execute_enabled) {
      return await fail(
        "Automatic payout execution is switched off. The decision is recorded; move the money on the portal.",
        409,
      );
    }
    if (
      wantAuto && !oneTimeBatchDecline &&
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

    let beforeStatus: string | null = null;
    let afterStatus: string | null = null;
    let session: Session | null = null;
    try {
      session = await openSession(config);

      // Refuse to touch anything the provider does not still show as pending.
      try {
        beforeStatus = await readPayoutStatusWithRetry(
          session.cookie,
          session.base,
          Number(maven_id),
          payout.first_seen_at,
        );
      } catch (firstError) {
        if (
          session.account !== "collector" ||
          !isAmbiguousProviderError(firstError)
        ) throw firstError;
        session = await openOperatorSession(config);
        beforeStatus = await readPayoutStatusWithRetry(
          session.cookie,
          session.base,
          Number(maven_id),
          payout.first_seen_at,
        );
      }
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
      if (normalizedProviderStatus(beforeStatus) === target) {
        afterStatus = beforeStatus; // already there; nothing to send
      } else if (normalizedProviderStatus(beforeStatus) !== "PENDING" && !/pending|process/i.test(beforeStatus)) {
        return await fail(
          `Provider status is ${beforeStatus}, not pending — refusing (no reversals through this worker).`,
          409,
        );
      } else {
        let submitError: unknown = null;
        try {
          await submitPayoutUpdate(
            session,
            Number(maven_id),
            target,
            utr_number,
            remark,
            proof_url,
          );
        } catch (error) {
          // A lost timeout/5xx response may happen after Maven commits. Match
          // pay-in: read back once and never issue a blind duplicate payout.
          if (!isAmbiguousProviderError(error)) throw error;
          submitError = error;
        }

        // 4. Verify against the provider's own view before claiming anything.
        await sleep(VERIFY_DELAY_MS);
        try {
          afterStatus = await readPayoutStatusWithRetry(
            session.cookie,
            session.base,
            Number(maven_id),
            payout.first_seen_at,
          );
        } catch (readBackError) {
          if (submitError) {
            const submitMessage = submitError instanceof Error
              ? submitError.message
              : String(submitError);
            const readMessage = readBackError instanceof Error
              ? readBackError.message
              : String(readBackError);
            throw new Error(
              `${submitMessage}; provider read-back also failed: ${readMessage}`,
            );
          }
          throw readBackError;
        }
        if (!afterStatus || normalizedProviderStatus(afterStatus) !== target) {
          if (submitError) {
            const message = submitError instanceof Error
              ? submitError.message
              : String(submitError);
            return await fail(
              `${message}; read-back did not confirm the requested state (expected ${target}, provider says ${afterStatus ?? "unknown"})`,
              502,
            );
          }
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
        approved_by: actor_name,
        updated_utc: nowIso,
        manual_status_override: true,
        manual_reopened_at: null,
        manual_reopened_by: null,
      })
      .eq("maven_id", maven_id);

    return json({
      ok: true,
      mode: oneTimeBatchDecline ? "batch_decline" : wantAuto ? "auto" : "manual",
      maven_id,
      decision,
      before_status: beforeStatus,
      after_status: afterStatus,
      audit_log_id: logRow.id,
      executed_on_provider: true,
      account: session?.account,
      fallback_reason: session?.fallback_reason ?? null,
      execution_ms: Math.round(performance.now() - requestStartedAt),
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
