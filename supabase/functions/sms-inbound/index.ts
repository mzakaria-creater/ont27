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
    const v = payload[name];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

// Fallback extraction straight from the raw SMS text, used only when the
// caller did not already supply a clean field. As of 2026-09-19 the device
// forwarder app started sending {"time": "...", "key": "<sms text>"} instead
// of a flat {message: "..."} body — the "key" field was not in the recognized
// name list, so the message never got unwrapped, and everything below
// (amount, reference, category, wallet) fell through to null/"unknown".
function extractAmount(message: string): number | null {
  const m = message.match(/(?:بمبلغ|مبلغ|تم\s*تحويل|تم\s*استلام\s*مبلغ)\s*([\d.,]+)\s*(?=جنيه)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractBalance(message: string): number | null {
  const m = message.match(/رصيدك\s*الحالي\s*([\d.,]+)\s*(?=جنيه)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractReference(message: string): string | null {
  return message.match(/رقم\s*(?:المعاملة|العملية)\s*[:：]?\s*(\d+)/)?.[1] ?? null;
}

// Orange Cash deposits rarely include the sender's phone number, and
// repairPaidSmsMatches() then falls back to matching by sender name — which
// stays null (and the SMS unmatchable) unless we pull it from "... من <name>،".
// Anchored to "، رصيدك" (the deposit-confirmation clause) specifically —
// plain "من\s+([^،\n]+)،" also matched promotional text like "اشحن ... من
// محفظة اورنچ كاش،" ("from the Orange Cash wallet,"), extracting a wallet
// label as if it were a person's name.
function extractSenderName(message: string): string | null {
  return message.match(/من\s+([^،\n]{2,60})،\s*رصيدك/)?.[1]?.trim() || null;
}

// Vodafone-style messages state the receiving wallet explicitly
// ("... على رقم محفظتك"); Orange Cash generally does not, so the reliable
// fallback there is the wallet currently mapped to this device (+ SIM slot
// when the caller sends one).
//
// There used to be a second fallback here -- "grab any 01xxxxxxxxx-shaped
// number anywhere in the message" -- which was actively wrong, not just
// unhelpful: an Orange Cash deposit confirmation embeds the SENDER's own
// phone number right in their name ("...من احمد سليمان الوردانى
// سالم-01222486081، رصيدك...", no space before the number), and that regex
// happily matched it and reported it as the RECEIVING wallet. Confirmed live
// on SMS #1000813: it produced receiver_number = the sender's own number,
// not the real receiving wallet. Orange Cash messages never actually state
// the receiving wallet in text at all, so guessing from a stray phone-shaped
// substring is worse than leaving it null and trusting the device mapping.
function extractWalletFromText(message: string): string | null {
  return message.match(/(?:على\s+رقم\s+محفظتك|إلى\s+رقم\s+محفظتك|رقم\s+المحفظة)\D*(01\d{9})/)?.[1] ?? null
}

// A device can have more than one SIM (and therefore more than one mapped
// wallet), and the forwarder app currently sends no sim_slot at all. When a
// slot is given, use it directly. When it is not and the device maps to
// several wallets, disambiguate using balance continuity: the SMS states the
// wallet's own post-transaction balance ("رصيدك الحالي"), so whichever
// candidate wallet's last known balance plus this amount matches that number
// is almost certainly the right one. If nothing matches (or we lack the
// balance/amount to compare), leave the wallet unresolved rather than guess —
// an unresolved wallet still gets a correctly categorized, readable SMS that
// an operator can assign manually; a wrong guess would misattribute money.
async function resolveWallet(
  device: string,
  simSlot: string | number | null,
  textWallet: string | null,
  amount: number | null,
  balance: number | null,
): Promise<string | null> {
  if (textWallet) return textWallet;
  if (!device || device === "unknown-device" || device === "unknown") return null;

  const { data } = await supabaseAdmin.from("wallet_device_map")
    .select("to_account_number, sim_slot").eq("device", device);
  const rows = (data ?? []) as { to_account_number: string; sim_slot: number | null }[];
  if (!rows.length) return null;

  if (simSlot !== null && simSlot !== undefined) {
    const match = rows.find((r) => String(r.sim_slot ?? "") === String(simSlot));
    if (match) return match.to_account_number;
  }

  const candidates = [...new Set(rows.map((r) => r.to_account_number).filter(Boolean))];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  if (amount === null || balance === null) return null;

  for (const wallet of candidates) {
    const { data: last } = await supabaseAdmin.from("inbound_sms")
      .select("balance_after")
      .or(`wallet_number.eq.${wallet},confirmed_wallet_number.eq.${wallet},receiver_number.eq.${wallet}`)
      .not("balance_after", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const previous = last?.balance_after == null ? null : Number(last.balance_after);
    if (previous !== null && Math.abs(previous + amount - balance) <= 1) return wallet;
  }
  return null;
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
    // "key"/"text" cover the device forwarder app's {time, key} envelope seen
    // in production from 2026-09-19; the rest keep older/other callers working.
    const messageValue = firstValue(payload, "message", "body", "text", "sms", "content", "msg", "key");
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
    const balance = extractBalance(message);

    let reference = referenceValue === null ? null : String(referenceValue);
    if (!reference) reference = extractReference(message);

    const explicitCategory = firstValue(payload, "sms_category", "category", "type");
    const categoryText = String(explicitCategory ?? "").trim().toLowerCase();
    const messageText = message.toLowerCase();
    const isWithdrawal = /(withdraw|withdrawal|debit|sent|paid out|سحب|خصم|تحويل إلى|تحويل الي|تم خصم)/i.test(messageText);
    const isIncoming = /(received|deposit|credited|credit|incoming|تم استلام|استلام|إيداع|تحويل أموال|تحويل اموال|تم تحويل)/i.test(messageText);

    const textWallet = walletValue !== null ? String(walletValue) : extractWalletFromText(message);
    // Only fall back to a device-mapped wallet when the message already
    // looks financial (an explicit wallet found in the text is fine either
    // way — that's real evidence, not a guess). Otherwise a promotional
    // message with no deposit/withdrawal wording at all still ends up
    // carrying a real wallet number just because its device has exactly one
    // mapped SIM, polluting an "unknown" row with data that implies evidence
    // that was never actually there.
    const wallet = textWallet
      ? textWallet
      : (isIncoming || isWithdrawal || amount !== null)
        ? await resolveWallet(device, simSlotValue, null, amount, balance).catch(() => null)
        : null;

    const smsCategory = ["deposit", "received", "income", "withdrawal", "expense"].includes(categoryText)
      ? categoryText
      : isWithdrawal
        ? "withdrawal"
        : (isIncoming || (amount !== null && wallet !== null))
          ? "deposit"
          : "unknown";

    // Write both the live column names the panel's matching logic reads
    // (sender_number, receiver_number/wallet_number, trx_id, sms_category)
    // and the older aliases (sender, wallet, trx_reference) some legacy
    // reporting still queries — cheap to keep both in sync.
    const row = {
      sender: senderValue === null ? null : String(senderValue),
      sender_number: senderValue === null ? null : String(senderValue),
      sender_name: (firstValue(payload, "sender_name", "name") === null ? null : String(firstValue(payload, "sender_name", "name"))) ?? extractSenderName(message),
      message,
      sms_first_line: message.split(/\r?\n/)[0]?.slice(0, 500) ?? message,
      wallet,
      receiver_number: wallet,
      wallet_number: wallet,
      amount,
      balance_after: balance,
      sms_category: smsCategory,
      trx_reference: reference,
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
