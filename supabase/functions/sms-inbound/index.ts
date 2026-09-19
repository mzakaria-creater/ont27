import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");

const rawSecretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
const secretKeys = rawSecretKeys ? JSON.parse(rawSecretKeys) as Record<string, string> : {};
const secretKey = Object.values(secretKeys)[0] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!secretKey) throw new Error("A Supabase secret key is required");

const supabaseAdmin = createClient(SUPABASE_URL, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-webhook-token, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function firstValue(payload: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = payload[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

// Fallback extraction straight from the raw SMS text, used only when the
// caller did not already supply a clean field. Most callers forwarding to
// this webhook only send {message, sender, device, ...} with no pre-parsed
// amount/wallet/reference, which left inbound_sms rows with no usable
// receiver_number — repairPaidSmsMatches then can never place them (see
// diagnostics.noUsableTime), so they sat unmatched forever.
function extractAmount(message: string): number | null {
  const m = message.match(/(?:بمبلغ|مبلغ|تم\s*تحويل|تم\s*استلام\s*مبلغ)\s*([\d.,]+)\s*(?=جنيه)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractReference(message: string): string | null {
  return message.match(/رقم\s*(?:المعاملة|العملية)\s*[:：]?\s*(\d+)/)?.[1] ?? null;
}

// Vodafone-style messages state the receiving wallet explicitly
// ("... على رقم محفظتك"); Orange Cash generally does not, so the reliable
// fallback there is the wallet currently mapped to this device + SIM slot.
function extractWalletFromText(message: string): string | null {
  const m = message.match(/(?:على\s+رقم\s+محفظتك|إلى\s+رقم\s+محفظتك|رقم\s+المحفظة)\D*(01\d{9})/);
  if (m) return m[1];
  const any = message.match(/01\d{9}/g);
  return any ? any[any.length - 1] : null;
}

async function walletForDevice(device: string, simSlot: string | number | null): Promise<string | null> {
  if (!device || device === "unknown-device") return null;
  let query = supabaseAdmin.from("wallet_device_map").select("to_account_number").eq("device", device);
  query = simSlot === null || simSlot === undefined ? query.is("sim_slot", null) : query.eq("sim_slot", Number(simSlot));
  const { data } = await query.limit(1).maybeSingle();
  return data?.to_account_number ?? null;
}

async function readPayload(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : { payload: body };
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    return Object.fromEntries(form.entries());
  }

  const text = await req.text();
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : { payload: body };
  } catch {
    return { message: text };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: jsonHeaders });
  if (req.method !== "POST") return response({ error: "Only POST is allowed" }, 405);

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const device = pathParts.at(-1) || "ont1";

  try {
    const payload = await readPayload(req);
    const messageValue = firstValue(payload, "message", "body", "text", "sms", "content", "msg");
    const senderValue = firstValue(payload, "sender", "from", "sender_number", "phone", "address", "number");
    const walletValue = firstValue(payload, "wallet", "wallet_number", "receiver_number", "to");
    const amountValue = firstValue(payload, "amount", "value", "transfer_amount");
    const referenceValue = firstValue(payload, "trx_reference", "trx_ref", "transaction_id", "transactionId", "reference", "ref", "utr");
    const providerValue = firstValue(payload, "provider", "network", "carrier") ?? "ont1";
    const simSlotValue = payload.sim_slot === undefined || payload.sim_slot === null ? null : payload.sim_slot as string | number;

    const message = messageValue === null ? null : String(messageValue);
    if (!message) return response({ error: "message is required" }, 400);

    const numericAmount = amountValue === null ? null : Number(String(amountValue).replace(/[^0-9.-]/g, ""));
    let amount = numericAmount !== null && Number.isFinite(numericAmount) ? numericAmount : null;
    if (amount === null) amount = extractAmount(message);

    let wallet = walletValue === null ? null : String(walletValue);
    if (!wallet) wallet = extractWalletFromText(message);
    if (!wallet) wallet = await walletForDevice(device, simSlotValue).catch(() => null);

    let reference = referenceValue === null ? null : String(referenceValue);
    if (!reference) reference = extractReference(message);

    const explicitCategory = firstValue(payload, "sms_category", "category", "type");
    const categoryText = String(explicitCategory ?? "").trim().toLowerCase();
    const messageText = message.toLowerCase();
    const isWithdrawal = /(withdraw|withdrawal|debit|sent|paid out|سحب|خصم|تحويل إلى|تحويل الي|تم خصم)/i.test(messageText);
    const isIncoming = /(received|deposit|credited|credit|incoming|تم استلام|استلام|إيداع|تحويل أموال|تحويل اموال|تم تحويل)/i.test(messageText);
    const smsCategory = ["deposit", "received", "income", "withdrawal", "expense"].includes(categoryText)
      ? categoryText
      : isWithdrawal
        ? "withdrawal"
        : (isIncoming || (amount !== null && wallet !== null))
          ? "deposit"
          : "unknown";

    // Use the live inbound_sms column names. The older aliases (sender,
    // wallet, trx_reference) are not persisted by the panel mirror and made
    // otherwise valid SMS messages invisible to wallet/transaction matching.
    const row = {
      sender_number: senderValue === null ? null : String(senderValue),
      sender_name: firstValue(payload, "sender_name", "name") === null ? null : String(firstValue(payload, "sender_name", "name")),
      message,
      sms_first_line: message.split(/\r?\n/)[0]?.slice(0, 500) ?? message,
      receiver_number: wallet,
      wallet_number: wallet,
      amount,
      sms_category: smsCategory,
      trx_id: reference,
      provider: String(providerValue),
      raw_payload: payload,
      raw_sms: message,
      sms_sender: senderValue === null ? null : String(senderValue),
      import_source: "sms-inbound-webhook",
      webhook_name: "sms-inbound",
      webhook_address: url.pathname,
      method: "POST",
      device_name: device,
      sim_slot: simSlotValue === null ? null : String(simSlotValue),
      received_at: new Date().toISOString(),
    };

    if (reference) {
      const { data: duplicate } = await supabaseAdmin.from("inbound_sms")
        .select("id").eq("trx_id", reference).maybeSingle();
      if (duplicate) return response({ ok: true, duplicate: true, id: duplicate.id, trx_id: reference }, 200);
    }

    const { data, error } = await supabaseAdmin
      .from("inbound_sms")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.error("inbound_sms insert failed", error);
      return response({ error: "Could not store SMS" }, 500);
    }

    return response({ ok: true, id: data.id }, 201);
  } catch (error) {
    console.error("sms-inbound request failed", error);
    return response({ error: "Invalid request" }, 400);
  }
});
