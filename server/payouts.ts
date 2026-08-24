import { Hono } from "hono";
import { db } from "./db.js";
import { requireAuth, requirePerm, requireSuperAdmin } from "./rbac.js";
import type { AuthEnv } from "./rbac.js";
import { MAX_PAGE } from "./paging.js";
import { autoLinkWithdrawalSms } from "./payoutSmsMatcher.js";

// Payouts = maven_payout_transactions. Key column is maven_id (Maven's id);
// ontarget_ref is OUR reference and is what the panel surfaces first.
// Observed statuses: PENDING | APPROVED | DECLINED. Amounts are EGP —
// the table has no currency column (currency lives in maven_raw_row).

export const payoutRoutes = new Hono<AuthEnv>();

payoutRoutes.use("*", requireAuth);

const LIST_COLUMNS =
  "maven_id, guid, ontarget_ref, status, amount, pay_by, merchant, account_name, mobile_no, agent_name, commission, remark, image_url, approved_by, matched_sms_id, created_utc, first_seen_at, last_seen_at, maven_raw_row";

const rawField = (raw: unknown, ...names: string[]) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  for (const name of names) {
    const wanted = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const match = entries.find(
      ([key]) => key.replace(/[^a-z0-9]/gi, "").toLowerCase() === wanted,
    );
    if (match && match[1] != null && String(match[1]).trim())
      return String(match[1]).trim();
  }
  return null;
};

const presentPayout = (row: Record<string, unknown>) => {
  const raw = row.maven_raw_row;
  const amount = Number(row.amount ?? 0);
  const commission = row.commission == null ? null : Number(row.commission);
  const { maven_raw_row: _raw, ...safe } = row;
  return {
    ...safe,
    merchant_reference:
      rawField(
        raw,
        "merchant_reference",
        "merchant reference",
        "merchant_tx_reference",
      ) ??
      row.ontarget_ref ??
      row.guid ??
      null,
    payment_type:
      rawField(raw, "payment_type", "payment type", "payment_method") ??
      row.pay_by ??
      null,
    user_account_number: rawField(
      raw,
      "user_account_number",
      "user account number",
      "account_number",
      "bank_account_number",
    ),
    bank_name: rawField(raw, "bank_name", "bank name") ?? row.pay_by ?? null,
    bank_ifsc: rawField(raw, "bank_ifsc", "bank ifsc", "ifsc", "ifsc_code"),
    utr_number: rawField(
      raw,
      "utr_number",
      "utr number",
      "utr",
      "bank_reference",
    ),
    currency: rawField(raw, "currency", "currency_code") ?? "EGP",
    master_merchant: rawField(
      raw,
      "master_merchant",
      "master merchant",
      "gateway",
      "provider",
    ),
    commission_percentage:
      commission != null && Number.isFinite(commission) && amount > 0
        ? (commission / amount) * 100
        : null,
  };
};

const PROOF_BUCKET = "pop";
const PROOF_PREFIX = "payout-proofs/";

payoutRoutes.get("/", requirePerm("payouts", "can_view"), async (c) => {
  const status = c.req.query("status")?.toUpperCase();
  const q = c.req.query("q")?.trim();
  const from = c.req.query("from")?.trim();
  const to = c.req.query("to")?.trim();
  const merchant = c.req.query("merchant")?.trim();
  const method = c.req.query("method")?.trim();
  const limit = Math.min(Number(c.req.query("limit")) || 25, MAX_PAGE);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  let query = db
    .from("maven_payout_transactions")
    .select(LIST_COLUMNS, { count: "exact" })
    .order("ontarget_ref", { ascending: false, nullsFirst: false })
    .order("maven_id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from))
    query = query.gte("first_seen_at", `${from}T00:00:00+03:00`);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to))
    query = query.lte("first_seen_at", `${to}T23:59:59.999+03:00`);
  if (merchant) query = query.ilike("merchant", `%${merchant.replaceAll(",", " ")}%`);
  if (method) query = query.ilike("pay_by", `%${method.replaceAll(",", " ")}%`);
  if (q) {
    const like = `%${q.replaceAll(",", " ")}%`;
    const ors = [
      `ontarget_ref.ilike.${like}`,
      `mobile_no.ilike.${like}`,
      `account_name.ilike.${like}`,
      `merchant.ilike.${like}`,
      `agent_name.ilike.${like}`,
    ];
    if (/^\d+$/.test(q)) ors.push(`maven_id.eq.${q}`);
    query = query.or(ors.join(","));
  }

  const { data, count, error } = await query;
  if (error) return c.json({ error: "db_error", detail: error.message }, 500);
  const rows = data ?? [];
  const decisionById = new Map<number, Record<string, unknown>>();
  const smsById = new Map<number, Record<string, unknown>>();
  if (rows.length) {
    const smsIds = rows
      .map((row) => row.matched_sms_id)
      .filter((id): id is number => id != null);
    const [{ data: decisions }, { data: smsRows }] = await Promise.all([
      db
        .from("payout_decision_log")
        .select(
          "maven_id, decision, actor_name, remark, executed_on_provider, created_at",
        )
        .in(
          "maven_id",
          rows.map((row) => row.maven_id),
        )
        .order("created_at", { ascending: false }),
      smsIds.length
        ? db
            .from("inbound_sms")
            .select(
              "id, received_at, amount, receiver_number, wallet_number, provider, trx_id, trx_reference, balance_after, message",
            )
            .in("id", smsIds)
        : Promise.resolve({ data: [] }),
    ]);
    for (const row of decisions ?? [])
      if (!decisionById.has(Number(row.maven_id)))
        decisionById.set(Number(row.maven_id), row);
    for (const row of smsRows ?? []) smsById.set(Number(row.id), row);
  }
  return c.json({
    rows: rows.map((row) => ({
      ...presentPayout(row),
      decision: decisionById.get(row.maven_id) ?? null,
      linked_sms: row.matched_sms_id
        ? (smsById.get(Number(row.matched_sms_id)) ?? null)
        : null,
    })),
    total: count ?? 0,
    limit,
    offset,
  });
});

// Keep static settings routes above /:mavenId. The previous route order made
// "execution-settings" hit the dynamic ID handler and return bad_id.
payoutRoutes.get(
  "/settings/execution",
  requirePerm("payouts", "can_view"),
  async (c) => {
    const { data, error } = await db
      .from("payout_execution_settings")
      .select("auto_execute_enabled, max_auto_amount, updated_at, updated_by")
      .eq("id", 1)
      .maybeSingle();
    if (error) return c.json({ error: "db_error", detail: error.message }, 500);
    return c.json({
      settings: data ?? { auto_execute_enabled: false, max_auto_amount: null },
    });
  },
);

payoutRoutes.put("/settings/execution", requireSuperAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const enabled = body?.auto_execute_enabled === true;
  const maxAmount = Number(body?.max_auto_amount);
  if (!Number.isFinite(maxAmount) || maxAmount <= 0)
    return c.json({ error: "positive_max_auto_amount_required" }, 400);
  const actor = c.get("actor");
  const update = {
    auto_execute_enabled: enabled,
    max_auto_amount: maxAmount,
    updated_at: new Date().toISOString(),
    updated_by: actor.username,
  };
  const { data, error } = await db
    .from("payout_execution_settings")
    .update(update)
    .eq("id", 1)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: "db_error", detail: error.message }, 500);
  if (!data) return c.json({ error: "settings_not_found" }, 404);
  await db
    .from("audit_log")
    .insert({
      actor_type: "manual_panel",
      actor_id: actor.sub,
      actor_name: actor.username,
      action: enabled
        ? "payout.provider_execution_enabled"
        : "payout.provider_execution_disabled",
      entity: "payout_execution_settings",
      entity_id: "1",
      after: update,
    });
  return c.json({ settings: data });
});

payoutRoutes.get("/:mavenId", requirePerm("payouts", "can_view"), async (c) => {
  const mavenId = c.req.param("mavenId");
  if (!/^\d+$/.test(mavenId)) return c.json({ error: "bad_id" }, 400);
  const { data, error } = await db
    .from("maven_payout_transactions")
    .select("*")
    .eq("maven_id", mavenId)
    .maybeSingle();
  if (error) return c.json({ error: "db_error", detail: error.message }, 500);
  if (!data) return c.json({ error: "not_found" }, 404);
  const [{ data: decisions }, { data: actions }, { data: linkedSms }] =
    await Promise.all([
      db
        .from("payout_decision_log")
        .select(
          "id, decision, actor_name, proof_url, remark, db_status_before, executed_on_provider, created_at",
        )
        .eq("maven_id", Number(mavenId))
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("audit_log")
        .select("id, actor_name, action, before, after, created_at")
        .eq("entity", "maven_payout_transactions")
        .eq("entity_id", mavenId)
        .order("created_at", { ascending: false })
        .limit(100),
      data.matched_sms_id
        ? db
            .from("inbound_sms")
            .select(
              "id, received_at, amount, receiver_number, wallet_number, provider, trx_id, trx_reference, balance_after, message",
            )
            .eq("id", data.matched_sms_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
  return c.json({
    payout: {
      ...data,
      linked_sms: linkedSms ?? null,
      decisions: decisions ?? [],
      actions: actions ?? [],
    },
  });
});

payoutRoutes.put("/:mavenId", requirePerm("payouts", "can_edit"), async (c) => {
  const mavenId = c.req.param("mavenId");
  if (!/^\d+$/.test(mavenId)) return c.json({ error: "bad_id" }, 400);
  const body = await c.req.json().catch(() => null);
  const value = (key: string, max: number) =>
    typeof body?.[key] === "string"
      ? body[key].trim().slice(0, max) || null
      : null;
  const update = {
    account_name: value("account_name", 160),
    mobile_no: value("mobile_no", 40),
    pay_by: value("pay_by", 80),
    merchant: value("merchant", 180),
    remark: value("remark", 500),
    image_url: value("image_url", 1000),
    updated_utc: new Date().toISOString(),
  };
  const baseUrl = process.env.SUPABASE_URL;
  const allowedProofPrefix = `${baseUrl}/storage/v1/object/public/${PROOF_BUCKET}/${PROOF_PREFIX}`;
  if (update.image_url && !update.image_url.startsWith(allowedProofPrefix))
    return c.json({ error: "invalid_proof_url" }, 400);
  if (update.mobile_no && !/^\+?[0-9\s()-]{7,24}$/.test(update.mobile_no))
    return c.json({ error: "invalid_mobile_no" }, 400);
  const { data: before, error: readError } = await db
    .from("maven_payout_transactions")
    .select("maven_id, account_name, mobile_no, pay_by, merchant, remark, image_url")
    .eq("maven_id", mavenId)
    .maybeSingle();
  if (readError)
    return c.json({ error: "db_error", detail: readError.message }, 500);
  if (!before) return c.json({ error: "not_found" }, 404);
  const { data, error } = await db
    .from("maven_payout_transactions")
    .update(update)
    .eq("maven_id", mavenId)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: "db_error", detail: error.message }, 500);
  const actor = c.get("actor");
  await db
    .from("audit_log")
    .insert({
      actor_type: "manual_panel",
      actor_id: actor.sub,
      actor_name: actor.username,
      action: "payout.details_edited",
      entity: "maven_payout_transactions",
      entity_id: mavenId,
      before,
      after: update,
    });
  return c.json({ payout: data });
});

payoutRoutes.post(
  "/proof",
  requirePerm("payouts", "can_approve"),
  async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size < 1)
      return c.json({ error: "proof_file_required" }, 400);
    if (file.size > 10 * 1024 * 1024)
      return c.json({ error: "proof_file_too_large" }, 400);
    if (
      !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
        file.type,
      )
    ) {
      return c.json({ error: "invalid_proof_type" }, 400);
    }

    const actor = c.get("actor");
    const safeName =
      file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "proof";
    const path = `${PROOF_PREFIX}${actor.sub}/${Date.now()}-${safeName}`;
    const { error } = await db.storage
      .from(PROOF_BUCKET)
      .upload(path, new Uint8Array(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: false,
      });
    if (error)
      return c.json(
        { error: "proof_upload_failed", detail: error.message },
        500,
      );
    const { data } = db.storage.from(PROOF_BUCKET).getPublicUrl(path);
    return c.json({ proof_url: data.publicUrl, path });
  },
);

payoutRoutes.post(
  "/:mavenId/decision",
  requirePerm("payouts", "can_approve"),
  async (c) => {
    const mavenId = c.req.param("mavenId");
    if (!/^\d+$/.test(mavenId)) return c.json({ error: "bad_id" }, 400);

    const body = await c.req.json().catch(() => null);
    const decision = body?.decision as "APPROVED" | "DECLINED" | undefined;
    const remark =
      typeof body?.remark === "string" ? body.remark.slice(0, 500) : undefined;
    const proofUrl =
      typeof body?.proof_url === "string" ? body.proof_url.trim() : undefined;
    if (decision !== "APPROVED" && decision !== "DECLINED")
      return c.json({ error: "bad_decision" }, 400);
    const baseUrl = process.env.SUPABASE_URL;
    const allowedProofPrefix = `${baseUrl}/storage/v1/object/public/${PROOF_BUCKET}/${PROOF_PREFIX}`;
    if (proofUrl && !proofUrl.startsWith(allowedProofPrefix))
      return c.json({ error: "invalid_proof_url" }, 400);

    await autoLinkWithdrawalSms(100).catch((error) =>
      console.error("pre-decision WD SMS matcher failed:", error),
    );
    const { data: before, error: readErr } = await db
      .from("maven_payout_transactions")
      .select(
        "maven_id, status, amount, ontarget_ref, merchant, matched_sms_id",
      )
      .eq("maven_id", mavenId)
      .maybeSingle();
    if (readErr)
      return c.json({ error: "db_error", detail: readErr.message }, 500);
    if (!before) return c.json({ error: "not_found" }, 404);
    const { data: linkedSms } = before.matched_sms_id
      ? await db
          .from("inbound_sms")
          .select("id, trx_id, trx_reference, receiver_number, amount")
          .eq("id", before.matched_sms_id)
          .maybeSingle()
      : { data: null };
    if (decision === "APPROVED" && !proofUrl && !linkedSms)
      return c.json({ error: "payment_proof_required" }, 400);
    if (before.status !== "PENDING") {
      return c.json({ error: "not_pending", status: before.status }, 409);
    }

    // Provider actions from this route are live-only. The worker still enforces
    // the kill switch and amount cap, and verifies provider read-back before it
    // can report executed_on_provider=true.
    if (body?.mode !== "auto")
      return c.json({ error: "live_provider_execution_required" }, 400);
    const mode = "auto" as const;
    const suppliedUtr =
      typeof body?.utr_number === "string"
        ? body.utr_number.trim().slice(0, 120)
        : "";
    const utrNumber =
      suppliedUtr || linkedSms?.trx_id || linkedSms?.trx_reference || "";
    if (mode === "auto" && decision === "APPROVED" && !utrNumber)
      return c.json({ error: "utr_required" }, 400);

    const actor = c.get("actor");
    const serviceKey = process.env.SUPABASE_SECRET_KEY;
    if (!baseUrl || !serviceKey)
      return c.json({ error: "worker_not_configured" }, 500);
    const workerUrl = `${baseUrl}/functions/v1/payout-execute-worker`;
    const workerResponse = await fetch(workerUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        maven_id: Number(mavenId),
        decision,
        actor_name: actor.username,
        proof_url: proofUrl,
        remark,
        mode,
        utr_number: utrNumber || undefined,
      }),
    });
    const workerResult = (await workerResponse
      .json()
      .catch(() => ({ error: "worker_invalid_response" }))) as Record<
      string,
      unknown
    >;

    await db.from("audit_log").insert({
      actor_type: "manual_panel",
      actor_id: actor.sub,
      actor_name: actor.username,
      action: `payout.${decision.toLowerCase()}`,
      entity: "maven_payout_transactions",
      entity_id: mavenId,
      before: { status: before.status, amount: before.amount },
      after: {
        decision,
        mode,
        remark,
        executed_on_provider: workerResult.executed_on_provider === true,
        provider_status_after: workerResult.after_status ?? null,
      },
    });

    if (!workerResponse.ok)
      return c.json(
        { error: "worker_failed", worker: workerResult },
        workerResponse.status as 400 | 401 | 403 | 404 | 409 | 500,
      );
    // Report exactly what the worker verified — never a friendlier version of it.
    return c.json(workerResult);
  },
);
