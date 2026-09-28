import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import {
  effectiveProviderDecision,
  isAmbiguousProviderError,
  providerStateMatches,
  shouldReconcileAutomationTerminal,
  type ProviderDecision,
} from "../_shared/ngpayExecution.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ============================================================================
// ngpay-approve — REAL provider execution for NGPay deposit decisions.
// (see earlier versions for full history)
//
// 2026-09-25: login hardening + account fallback. Maven started redirecting
// the collector (Supplier) login to /ResetPassword (forced password reset).
// The old login accepted ANY 302 with a cookie, so the worker believed it was
// logged in and every GetTransactionDetails came back as a generic HTTP 500.
// Login now fails loudly unless the redirect lands inside the back office, and
// if the collector account is blocked (reset / login page) the worker falls
// back to the operator account (MAVEN_OPERATOR_* on MAVEN_OPERATOR_BASE).
// ============================================================================

const DEFAULT_BASE = "https://bo.maven-consulting.co/Supplier";
const DEFAULT_OPERATOR_BASE = "https://bo.maven-consulting.co/Supplieroperator";

const REMARKS: Record<string, string> = {
  PAID: "Your payment has been successfully received. Thank you!",
  DECLINED: "No payment details shared",
};

const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

function pc(v: string | null): string {
  if (!v) return "";
  return v.split(/,(?=\s*[^;,=]+=[^;,]+)/g).flatMap((c) => c.split("\n")).map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(u: string, p: string, base: string): Promise<string> {
  const lp = await fetch(`${base}/Login/PostV2`, {
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Username: u, Password: p }),
  });
  const cookie = pc(lp.headers.get("set-cookie"));
  const location = lp.headers.get("location") ?? "";
  if (!cookie || lp.status >= 400) throw new Error(`provider login failed (${lp.status})`);
  if (/resetpassword/i.test(location)) throw new Error("provider login blocked: password reset required");
  if (lp.status !== 302 || /\/login|\/error/i.test(location)) throw new Error(`provider login rejected (${lp.status} -> ${location || "no redirect"})`);
  return cookie;
}

type Session = { cookie: string; base: string; account: "collector" | "operator"; fallback_reason?: string };

async function openSession(cfg: Map<string, string>): Promise<Session> {
  const cu = cfg.get("MAVEN_COLLECTOR_USERNAME") || cfg.get("MAVEN_USERNAME");
  const cp = cfg.get("MAVEN_COLLECTOR_PASSWORD") || cfg.get("MAVEN_PASSWORD");
  const cbase = cfg.get("MAVEN_COLLECTOR_BASE") || DEFAULT_BASE;
  const ou = cfg.get("MAVEN_OPERATOR_USERNAME");
  const op = cfg.get("MAVEN_OPERATOR_PASSWORD");
  const obase = cfg.get("MAVEN_OPERATOR_BASE") || DEFAULT_OPERATOR_BASE;
  let firstErr = "";
  if (cu && cp) {
    try { return { cookie: await login(cu, cp, cbase), base: cbase, account: "collector" }; }
    catch (e) { firstErr = e instanceof Error ? e.message : String(e); }
  }
  if (ou && op) {
    const cookie = await login(ou, op, obase);
    return { cookie, base: obase, account: "operator", fallback_reason: firstErr || "collector credentials missing" };
  }
  throw new Error(firstErr || "Missing provider credentials in maven_runtime_config");
}

async function openOperatorSession(cfg: Map<string, string>): Promise<Session> {
  const ou = cfg.get("MAVEN_OPERATOR_USERNAME");
  const op = cfg.get("MAVEN_OPERATOR_PASSWORD");
  const obase = cfg.get("MAVEN_OPERATOR_BASE") || DEFAULT_OPERATOR_BASE;
  if (!ou || !op) throw new Error("Operator fallback credentials are not configured");
  return { cookie: await login(ou, op, obase), base: obase, account: "operator", fallback_reason: "collector details endpoint failed after retry" };
}

async function getDetails(cookie: string, transactionId: string | number, base: string) {
  const r = await fetch(`${base}/Transactions/GetTransactionDetails?transactionId=${transactionId}`, {
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    headers: { cookie, "X-Requested-With": "XMLHttpRequest", accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GetTransactionDetails HTTP ${r.status}`);
  return r.json();
}

async function getDetailsWithRetry(cookie: string, transactionId: string | number, base: string) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await getDetails(cookie, transactionId, base);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = isAmbiguousProviderError(e);
      if (!retryable || attempt === RETRY_ATTEMPTS) {
        throw new Error(attempt > 1 ? `${msg} (after ${attempt} attempts)` : msg);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

async function submitUpdate(cookie: string, transactionId: string | number, targetStatus: string, details: any, base: string, overrideAmount?: number) {
  const remark = REMARKS[targetStatus] || "";
  const body = new URLSearchParams({
    transactionId: String(transactionId),
    status: targetStatus,
    remark,
    amount: String(overrideAmount ?? details.Amount ?? ""),
    chkTestTxn: String(details.chkTestTxn ?? false),
    OUstatus: "0",
    iPayInfo: details.iPayinfo ?? "",
    comment: remark,
    bankId: String(details.BankId ?? 0),
    operatorId: String(details.OperatorId ?? 0),
  });
  const r = await fetch(`${base}/Transactions/UpdateTransaction`, {
    signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      referer: `${base}/Transactions/GetP2PPendingTransactionList`,
      origin: "https://bo.maven-consulting.co",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) throw new Error(`UpdateTransaction HTTP ${r.status}: ${text.slice(0, 200)}`);
  if (parsed && parsed.success === false) throw new Error(`UpdateTransaction rejected: ${parsed.message ?? text.slice(0, 200)}`);
  if (parsed && typeof parsed.redirect === "string") throw new Error(`UpdateTransaction not authenticated (redirect ${parsed.redirect})`);
  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestStartedAt = performance.now();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token || token !== serviceKey) return json({ error: "unauthorized" }, 401);

    const configNames = [
      "MAVEN_COLLECTOR_USERNAME", "MAVEN_USERNAME",
      "MAVEN_COLLECTOR_PASSWORD", "MAVEN_PASSWORD",
      "MAVEN_COLLECTOR_BASE",
      "MAVEN_OPERATOR_USERNAME", "MAVEN_OPERATOR_PASSWORD", "MAVEN_OPERATOR_BASE",
    ];
    const { data: configRows, error: configErr } = await sb
      .from("maven_runtime_config")
      .select("name,value")
      .eq("owner_name", "global")
      .in("name", configNames);
    if (configErr) return json({ error: `Provider configuration read failed: ${configErr.message}` }, 500);
    const config = new Map((configRows ?? []).map((row: { name: string; value: string }) => [row.name, row.value]));

    const body = await req.json().catch(() => ({}));
    const { tx_id, decision, actor_name, remark, action, allow_reversal, source, override_amount } = body as {
      tx_id?: number; decision?: ProviderDecision; actor_name?: string; remark?: string; action?: string; allow_reversal?: boolean; source?: string; override_amount?: number;
    };

    if (!tx_id) return json({ error: "tx_id is required" }, 400);

    if (action === "details") {
      let s = await openSession(config);
      let details: any;
      try {
        details = await getDetailsWithRetry(s.cookie, tx_id, s.base);
      } catch (firstErr) {
        if (s.account !== "collector" || !isAmbiguousProviderError(firstErr)) throw firstErr;
        s = await openOperatorSession(config);
        details = await getDetailsWithRetry(s.cookie, tx_id, s.base);
      }
      return json({ ok: true, mode: "details", tx_id, provider_status: details.Status ?? null, amount: details.Amount ?? null, account: s.account, fallback_reason: s.fallback_reason ?? null });
    }

    if (!decision || !["PAID", "DECLINED", "EXPIRED", "UNDERPAID", "OVERPAID"].includes(decision)) return json({ error: "unsupported provider status" }, 400);
    if (!actor_name) return json({ error: "actor_name is required" }, 400);

    let amountOverride: number | undefined;
    if (override_amount != null) {
      const n = Number(override_amount);
      if (!Number.isFinite(n) || n <= 0) return json({ error: "invalid override_amount" }, 400);
      amountOverride = n;
    }

    const { data: row, error: rowErr } = await sb
      .from("maven_transactions")
      .select("tx_id, ontarget_ref, status, amount, gateway, master_merchant")
      .eq("tx_id", tx_id)
      .maybeSingle();
    if (rowErr) return json({ error: rowErr.message }, 500);
    if (!row) return json({ error: `No transaction for tx_id ${tx_id}` }, 404);
    const gatewayKey = String(row.gateway ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const isNgPay = gatewayKey === "nagupayp2p" || gatewayKey === "nagopayp2p" || gatewayKey.includes("nagupay") || gatewayKey.includes("nagopay");
    if (!isNgPay) return json({ error: `This worker only executes NGPay deposits — got gateway=${row.gateway}` }, 400);

    const { data: logRow, error: logErr } = await sb
      .from("deposit_decision_log")
      .insert({
        tx_id,
        ontarget_ref: row.ontarget_ref,
        decision,
        actor_name,
        reason: remark ?? null,
        db_status_before: row.status,
        executed_on_provider: false,
      })
      .select()
      .single();
    if (logErr) return json({ error: `Audit log write failed, aborting: ${logErr.message}` }, 500);

    const fail = async (msg: string, status = 500) => {
      await sb.from("deposit_decision_log").update({ reason: `${remark ? remark + " | " : ""}FAILED: ${msg}` }).eq("id", logRow.id);
      return json({ ok: false, error: msg, audit_log_id: logRow.id, executed_on_provider: false }, status);
    };

    let beforeStatus: string | null = null;
    let afterStatus: string | null = null;
    let afterAmount: number | null = null;
    let session: Session | null = null;
    try {
      session = await openSession(config);
      let cookie = session.cookie;
      let base = session.base;
      let before: any;
      try {
        before = await getDetailsWithRetry(cookie, tx_id, base);
      } catch (firstErr) {
        if (session.account !== "collector" || !isAmbiguousProviderError(firstErr)) throw firstErr;
        session = await openOperatorSession(config);
        cookie = session.cookie;
        base = session.base;
        before = await getDetailsWithRetry(cookie, tx_id, base);
      }
      beforeStatus = before.Status ?? null;
      await sb.from("deposit_decision_log").update({ provider_raw_status_at_decision: beforeStatus }).eq("id", logRow.id);

      const providerAmount = before.Amount == null ? null : Number(before.Amount);
      // Maven represents a lower amount on an already-PAID transaction as
      // UNDERPAID. Sending PAID with a lower amount leaves the provider value
      // unchanged (and makes every amount edit look like worker_failed).
      const effectiveDecision = effectiveProviderDecision(decision, beforeStatus, providerAmount, amountOverride);
      const amountAlreadyRight = amountOverride == null
        || (providerAmount != null && Math.abs(providerAmount - amountOverride) <= 0.009);

      if (beforeStatus === effectiveDecision && amountAlreadyRight) {
        afterStatus = beforeStatus;
        if (amountOverride != null) afterAmount = providerAmount;
      } else {
        if (beforeStatus !== "PENDING") {
          const repriceInPlace = amountOverride != null && beforeStatus === effectiveDecision;
          const safeReversal = allow_reversal === true && ["PAID", "DECLINED"].includes(effectiveDecision) && ["PAID", "DECLINED"].includes(String(beforeStatus ?? "")) && beforeStatus !== effectiveDecision && ["manual_fix_decline_reversal", "complaint", "direct_edit"].includes(String(source ?? ""));
          const safeUnderpayment = amountOverride != null && effectiveDecision === "UNDERPAID" && beforeStatus === "PAID" && providerAmount != null && amountOverride < providerAmount;
          if (!repriceInPlace && !safeReversal && !safeUnderpayment) {
            if (shouldReconcileAutomationTerminal(actor_name, beforeStatus, effectiveDecision)) {
              const observedAt = new Date().toISOString();
              const { error: syncError } = await sb.from("maven_transactions").update({
                status: beforeStatus,
                approved_by: "Maven Team",
                last_status_change: observedAt,
                updated_at: observedAt,
              }).eq("tx_id", tx_id);
              if (syncError) return await fail(`Provider is ${beforeStatus}; local mirror repair failed: ${syncError.message}`);
              await sb.from("deposit_decision_log").update({
                decision: beforeStatus,
                actor_name: "Maven Team",
                reason: `Automation skipped: Maven is already ${beforeStatus}; local mirror repaired`,
                executed_on_provider: true,
              }).eq("id", logRow.id);
              return json({
                ok: true,
                tx_id,
                skipped: "provider_already_terminal",
                requested_decision: decision,
                before_status: beforeStatus,
                after_status: beforeStatus,
                executed_on_provider: true,
                provider_action_observed: true,
                audit_log_id: logRow.id,
              });
            }
            return await fail(`Live provider status is ${beforeStatus}, not PENDING — refusing reversal`, 409);
          }
        }
        let submitError: unknown = null;
        try {
          await submitUpdate(cookie, tx_id, effectiveDecision, before, base, amountOverride);
        } catch (error) {
          // A timeout/5xx is not proof that Maven rejected the write. The
          // response is often lost after the provider commits. Read back once
          // before returning worker_failed; do not issue a blind duplicate
          // write from this request.
          if (!isAmbiguousProviderError(error)) throw error;
          submitError = error;
        }

        let after: any;
        try {
          after = await getDetailsWithRetry(cookie, tx_id, base);
        } catch (readBackError) {
          if (submitError) {
            const submitMessage = submitError instanceof Error ? submitError.message : String(submitError);
            const readMessage = readBackError instanceof Error ? readBackError.message : String(readBackError);
            throw new Error(`${submitMessage}; provider read-back also failed: ${readMessage}`);
          }
          throw readBackError;
        }
        afterStatus = after.Status ?? null;
        if (!providerStateMatches(afterStatus, after.Amount, effectiveDecision, amountOverride)) {
          if (submitError) {
            const submitMessage = submitError instanceof Error ? submitError.message : String(submitError);
            throw new Error(`${submitMessage}; read-back did not confirm the requested state (expected ${effectiveDecision}, provider says ${afterStatus})`);
          }
          return await fail(`Update submitted but verify failed: expected ${effectiveDecision}, provider says ${afterStatus}`);
        }
        if (amountOverride != null) {
          afterAmount = after.Amount == null ? null : Number(after.Amount);
        }
      }
    } catch (e) {
      return await fail(e instanceof Error ? e.message : "provider execution failed");
    }

    const nowIso = new Date().toISOString();
    const [logUpdate, txUpdate] = await Promise.all([
      sb.from("deposit_decision_log").update({ executed_on_provider: true }).eq("id", logRow.id),
      sb.from("maven_transactions")
        .update({
          // Mirror what Maven actually confirmed. This matters for a reduced
          // amount on an existing PAID row, which Maven stores as UNDERPAID.
          status: afterStatus ?? decision, approved_by: actor_name, last_status_change: nowIso, updated_at: nowIso,
          ...(afterAmount != null ? {
            amount: afterAmount,
            local_amount: afterAmount,
            provider_amount: afterAmount,
            amount_sync_status: "matched",
            amount_mismatch_reason: null,
            amount_confirmed_at: nowIso,
            amount_confirmed_by: actor_name,
            settlement_blocked: false,
          } : {}),
        })
        .eq("tx_id", tx_id),
    ]);
    if (logUpdate.error) console.error("decision log finalization failed", { tx_id, error: logUpdate.error.message });
    const updErr = txUpdate.error;
    if (updErr) {
      return json({ ok: true, warning: `provider execution succeeded but local row update failed: ${updErr.message}`, tx_id, before_status: beforeStatus, after_status: afterStatus, audit_log_id: logRow.id, executed_on_provider: true, account: session?.account });
    }

    return json({
      ok: true,
      tx_id,
      ontarget_ref: row.ontarget_ref,
      decision,
      effective_decision: afterStatus ?? decision,
      actor_name,
      before_status: beforeStatus,
      after_status: afterStatus,
      amount_before: row.amount,
      amount_after: afterAmount,
      amount_synced: afterAmount != null,
      audit_log_id: logRow.id,
      executed_on_provider: true,
      account: session?.account,
      fallback_reason: session?.fallback_reason ?? null,
      execution_ms: Math.round(performance.now() - requestStartedAt),
    });
  } catch (err) {
    console.error("ngpay-approve error:", err);
    return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});
