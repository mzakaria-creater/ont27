import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import nodemailer from "npm:nodemailer@7.0.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");

const rawSecretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
const secretKeys = rawSecretKeys ? JSON.parse(rawSecretKeys) as Record<string, string> : {};
const secretKey = Object.values(secretKeys)[0] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!secretKey) throw new Error("A Supabase secret key is required");

const supabaseAdmin = createClient(SUPABASE_URL, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  // This webhook is retried by its callers. SDK-level retries turn one SMS
  // into several concurrent Data API requests during a 52x incident and can
  // prevent the database from recovering.
  db: { retry: false },
});

const MAVEN_WALLET_SWITCH_URL = `${SUPABASE_URL}/functions/v1/maven-wallet-switch`;

function normalizedPhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "").slice(-10);
}

// Balance thresholds are safety controls, so evaluate them from the SMS event
// itself. The five-minute cron remains a recovery pass for delayed webhooks.
async function switchWalletImmediately(wallet: unknown, balance: unknown, smsId: number, network: unknown = null): Promise<void> {
  const walletKey = normalizedPhone(wallet);
  const currentBalance = Number(balance);
  if (!Number.isFinite(currentBalance)) return;

  const { data: rules, error: rulesError } = await supabaseAdmin
    .from("maven_wallet_threshold_switch_rules")
    .select("id, bank_id, source_wallet, target_wallet, amount_threshold")
    .eq("active", true)
    .eq("status", "active");
  if (rulesError) throw rulesError;

  const networkKey = String(network ?? '').replace(/\s+/g, '').toLowerCase();
  for (const rule of rules ?? []) {
    const ruleNetworkKey = String(rule.payment_type ?? '').replace(/\s+/g, '').toLowerCase();
    const walletMatches = walletKey && normalizedPhone(rule.source_wallet) === walletKey;
    const networkMatches = !walletKey && networkKey && ruleNetworkKey === networkKey;
    if ((!walletMatches && !networkMatches) || currentBalance < Number(rule.amount_threshold)) continue;

    // Claim the rule before contacting Maven so two SMS retries cannot issue
    // two provider edits for the same bank.
    const now = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("maven_wallet_threshold_switch_rules")
      .update({ active: false, status: "paused", last_checked_at: now, updated_at: now })
      .eq("id", rule.id)
      .eq("active", true)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;

    try {
      const { data: live, error: liveError } = await supabaseAdmin
        .from("maven_banks_live_cache")
        .select("bank_id, phone_number")
        .eq("bank_id", rule.bank_id)
        .maybeSingle();
      if (liveError) throw liveError;
      if (!live || normalizedPhone(live.phone_number) !== walletKey) throw new Error(`maven bank ${rule.bank_id} is not ${rule.source_wallet}`);

      const response = await fetch(MAVEN_WALLET_SWITCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secretKey}`, apikey: secretKey },
        body: JSON.stringify({ bank_id: rule.bank_id, mode: "edit", new_number: rule.target_wallet, confirm: true }),
        signal: AbortSignal.timeout(45_000),
      });
      const provider = await response.json().catch(() => ({})) as Record<string, unknown>;
      const changedTo = normalizedPhone(provider.changed_to);
      if (!response.ok || provider.ok !== true || changedTo !== normalizedPhone(rule.target_wallet)) {
        throw new Error(String(provider.error ?? `maven switch failed (${response.status})`));
      }

      await supabaseAdmin.from("maven_wallet_threshold_switch_rules").update({
        status: "switched", switched_at: now, last_error: null, updated_at: now,
      }).eq("id", rule.id);
      await supabaseAdmin.from("audit_log").insert({
        actor_type: "system", actor_name: "sms-inbound", action: "maven_wallet_threshold_switch_succeeded",
        entity: "maven_wallet_threshold_switch_rules", entity_id: rule.id,
        after: { sms_id: smsId, observed_balance: currentBalance, source_wallet: rule.source_wallet, target_wallet: rule.target_wallet, provider },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabaseAdmin.from("maven_wallet_threshold_switch_rules").update({
        active: true, status: "active", last_error: message, updated_at: new Date().toISOString(),
      }).eq("id", rule.id);
      await supabaseAdmin.from("audit_log").insert({
        actor_type: "system", actor_name: "sms-inbound", action: "maven_wallet_threshold_switch_failed",
        entity: "maven_wallet_threshold_switch_rules", entity_id: rule.id,
        after: { sms_id: smsId, observed_balance: currentBalance, error: message },
      });
    }
  }
}

// "Money out" (withdrawal) SMS -- a transfer leaving one of our own wallets
// -- gets an immediate email alert, same SMTP credentials the
// transaction-approval-email function already uses in this project. This is
// deliberately NOT awaited before the webhook responds (see the
// EdgeRuntime.waitUntil call site below): a slow or down mail server must
// never add latency to -- or fail -- live SMS ingestion.
const WITHDRAWAL_ALERT_EMAIL = "minafx2@gmail.com";

// Confirmed live on SMS #1014741 (Orange Cash, "عملية تحويل أموال ناجحة
// بمبلغ 3700.00 جنيه، لرقم 01094182796، رسوم التحويل 15.00 جنيه، رصيدك
// الحالي 38.60 جنيه"): wallet_number/receiver_number on a withdrawal row is
// OUR OWN sending wallet, never the recipient -- same fact
// server/payoutSmsMatcher.ts's payoutDestination() already documents and
// extracts via this identical "لرقم" pattern. The first version of this
// alert used wallet_number/receiver_number as if it were the recipient and
// never surfaced the real destination number at all, nor the fee/balance
// that are sitting right there in the message.
function extractPayoutDestination(message: string): string | null {
  return message.match(/(?:لرقم|to\s+(?:number|phone)|recipient)\s*[:：-]?\s*(?:\+?20)?(01\d{9})/i)?.[1] ?? null;
}
function extractTransferFee(message: string): string | null {
  return message.match(/رسوم\s*(?:التحويل|السحب)\s*[:：]?\s*([\d.,]+)/)?.[1] ?? null;
}

function esc(value: unknown): string {
  return String(value ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// Red theme on purpose -- this is money LEAVING one of our wallets, the
// opposite event from transaction-approval-email's green "approved"
// template, and should read as an alert, not a confirmation.
function withdrawalAlertHtml(fields: { smsId: number; amount: string; recipient: string; ourWallet: string; fee: string; balanceAfter: string; provider: string; reference: string; device: string; receivedAt: string; message: string }): { subject: string; html: string; text: string } {
  const { smsId, amount, recipient, ourWallet, fee, balanceAfter, provider, reference, device, receivedAt, message } = fields;
  const subject = `Money Out SMS #${smsId}: ${amount} to ${recipient} (${provider})`;
  const rows: [string, string][] = [
    ["Amount", amount], ["To (recipient)", recipient], ["From our wallet", ourWallet],
    ["Transfer fee", fee], ["Balance after", balanceAfter], ["Provider", provider],
    ["Reference", reference], ["Device", device], ["Received", receivedAt],
  ].map(([label, value]) => [label, value]);
  const rowsHtml = rows.map(([label, value]) => `<tr><td style="padding:9px 0;color:#667085">${esc(label)}</td><td align="right" style="padding:9px 0;font-weight:700">${esc(value)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f6f3f3;font-family:Arial,Helvetica,sans-serif;color:#2a1515">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;background:#f6f3f3"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 32px rgba(120,20,20,.12)">
  <tr><td style="padding:30px 36px;background:#7f1d1d;color:#fff"><div style="font-weight:800;letter-spacing:1.5px;font-size:14px">ONTARGET</div><div style="margin-top:20px;width:50px;height:50px;line-height:50px;text-align:center;border-radius:50%;background:#ef4444;font-size:26px">&#9650;</div><h1 style="margin:14px 0 4px;font-size:27px">Money Out Alert</h1><div style="color:#fecaca">Withdrawal SMS detected -- wallet balance decreased</div></td></tr>
  <tr><td style="padding:30px 36px"><p style="font-size:15px;line-height:1.7;color:#57534e;margin:0 0 22px">A withdrawal SMS just reported money leaving one of our wallets (SMS #${smsId}).</p>
  <div style="border:1px solid #fecaca;border-radius:14px;overflow:hidden"><div style="padding:20px;background:#fef2f2;border-bottom:1px solid #fecaca"><div style="font-size:12px;color:#991b1b">AMOUNT OUT</div><div style="font-size:29px;font-weight:800;color:#7f1d1d;margin-top:4px">${esc(amount)}</div><div style="margin-top:9px;font-size:14px;color:#57534e">${esc(ourWallet)} &nbsp;&#8594;&nbsp; ${esc(recipient)}</div></div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:12px 20px;font-size:14px">${rowsHtml}</table></div>
  <div style="margin-top:22px;padding:14px 16px;background:#fafaf9;border-radius:10px;border:1px solid #e7e5e4;font-size:12.5px;color:#57534e;white-space:pre-wrap;direction:rtl;text-align:right">${esc(message)}</div></td></tr>
  <tr><td style="padding:18px 36px;background:#fafaf9;border-top:1px solid #e7e5e4;color:#a8a29e;font-size:12px">Internal operational alert from OnTarget.</td></tr></table></td></tr></table></body></html>`;
  const text = [
    `Money Out Alert -- withdrawal SMS detected.`, ``,
    `SMS #${smsId}`, `Amount: ${amount}`, `To (recipient): ${recipient}`,
    `From our wallet: ${ourWallet}`, `Transfer fee: ${fee}`, `Balance after: ${balanceAfter}`,
    `Provider: ${provider}`, `Reference: ${reference}`, `Device: ${device}`, `Received: ${receivedAt}`,
    ``, `Message:`, message,
  ].join("\n");
  return { subject, html, text };
}

async function sendWithdrawalAlertEmail(row: Record<string, unknown>, smsId: number): Promise<void> {
  const smtpUser = Deno.env.get("SMTP_USER");
  const smtpPassword = Deno.env.get("SMTP_PASSWORD");
  if (!smtpUser || !smtpPassword) {
    console.warn("withdrawal alert email skipped: SMTP not configured");
    return;
  }
  const transport = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST") || "mail.privateemail.com",
    port: Number(Deno.env.get("SMTP_PORT") || "465"),
    secure: Number(Deno.env.get("SMTP_PORT") || "465") === 465,
    auth: { user: smtpUser, pass: smtpPassword },
  });
  const message = String(row.message ?? "");
  const fee = extractTransferFee(message);
  const { subject, html, text } = withdrawalAlertHtml({
    smsId,
    amount: row.amount != null ? `${row.amount} EGP` : "—",
    recipient: extractPayoutDestination(message) ?? "—",
    ourWallet: String(row.wallet_number ?? row.receiver_number ?? "—"),
    fee: fee ? `${fee} EGP` : "—",
    balanceAfter: row.balance_after != null ? `${row.balance_after} EGP` : "—",
    provider: String(row.provider ?? "—"),
    reference: String(row.trx_reference ?? "—"),
    device: String(row.device_name ?? "—"),
    receivedAt: String(row.received_at ?? "—"),
    message,
  });
  await transport.sendMail({
    from: Deno.env.get("SMTP_FROM") || `OnTarget <${smtpUser}>`,
    to: WITHDRAWAL_ALERT_EMAIL,
    subject,
    html,
    text,
  });
}

const jsonHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-webhook-token, authorization",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
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

function normalizeDevice(value: unknown): string {
  const candidate = String(value ?? "").trim().toLowerCase();
  return /^ont(?:10|[1-9])$/.test(candidate) ? candidate : "unknown-device";
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
  // Vodafone Cash's "تم استلام" confirmation states the balance as
  // "رصيدك الحالي: 1327.79 جنيه" -- a colon between the label and the
  // number that this regex did not tolerate, so balance_after came back
  // null for every single Vodafone deposit (confirmed live: 0 of 273 in a
  // 24h window had a balance, vs 531 of 634 Orange ones, which never carry
  // that colon).
  const m = message.match(/رصيدك\s*الحالي\s*[:：]?\s*([\d.,]+)\s*(?=جنيه)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractReference(message: string): string | null {
  return message.match(/رقم\s*(?:المعاملة|العملية)\s*[:：]?\s*(\d+)/)?.[1] ?? null;
}

// The device-forwarder apps in production never actually send a
// provider/network/carrier field, so `provider` always fell back to the
// DEVICE identifier ("ont1", "ont2", ...) instead of a real network name.
// That silently broke two things at once: the SMS Live provider filter
// (Vodafone Cash / Orange Cash checkboxes match the `provider` column with
// ilike '%vodafone%'/'%orange%' — see server/sms.ts PROVIDER_FILTER_PATTERNS
// — so they matched nothing for any row through this path) and the
// method-logo badge, which showed the same generic mark for every row
// regardless of network. Now that both Vodafone and Orange wallets are live
// side by side, every row looked identical either way. Detect the network
// from the message text itself, the same signal mark_supported_sms_source()
// already trusts server-side.
function detectNetworkFromMessage(message: string): string | null {
  if (/vodafone/i.test(message) || /vf[- ]?cash/i.test(message) || /فودافون/.test(message)) return "Vodafone Cash";
  if (/orange/i.test(message) || /اورنج|اورنچ/.test(message)) return "Orange Cash";
  if (/etisalat|e&/i.test(message)) return "Etisalat Cash";
  if (/instapay|insta\s*pay/i.test(message) || /انستا\s*باي/.test(message)) return "InstaPay";
  if (/we\s*pay/i.test(message)) return "WE Pay";
  if (/alexbank|alex\s*bank|bank\s*of\s*alexandria/i.test(message) || /بنك\s*الاسكندرية/.test(message)) return "Alex Bank";
  return null;
}

// Real provider traffic that is never a deposit/withdrawal event on its own:
// balance-check pings ("رصيدك الحالي ... شكرا لاستخدامك"), promo/loyalty texts
// ("مبروك! كسبت ... هدية", "... تحويشة"), and bare envelope-header fragments
// the forwarder app sends alongside the real message body ("From : X()" with
// no content). None of these carry "بمبلغ" (the amount clause every real
// transfer confirmation has), so that absence plus the specific wording is
// enough to route them away from inbound_sms instead of piling up as
// unclassifiable "unknown" rows.
function classifyNotification(message: string): string | null {
  const trimmed = message.trim();
  if (/^From\s*:/i.test(trimmed) && trimmed.length < 60) return "envelope_fragment";
  if (/بمبلغ/.test(message)) return null;
  if (/رصيدك\s*الحالي/.test(message)) return "balance_check";
  if (/(هدية|تحويشة|مبروك)/.test(message)) return "promo";
  return null;
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

// Vodafone Cash's "تم استلام" confirmation states the sender's name in a
// completely separate clause from Orange's ("...من رقم X المسجل بإسم <name>
// على رقم محفظتك..." -- no trailing "، رصيدك" at all), so extractSenderName
// above never matched it. Combined with the wiring bug fixed below (row.*
// used to read senderValue directly instead of the already-extracted
// rawSender), Vodafone deposits carried NEITHER sender_number NOR
// sender_name -- a total identity blackout that Orange never has (its phone
// survives embedded in sender_name, "<name>-01xxxxxxxxx"). That forced every
// Vodafone deposit onto the weaker wallet+amount+time fallback instead of
// the identity-based matching paths, which is most of what made Vodafone
// automation noticeably less reliable than Orange's.
function extractVodafoneSenderName(message: string): string | null {
  return message.match(/المسجل\s+بإسم\s+([^\n]+?)\s*على\s+رقم\s+محفظتك/)?.[1]?.trim() ?? null;
}

function extractSenderNumber(message: string): string | null {
  const match = message.match(/(?:من|from)\s+[^\n،]*?(\+?(?:20|0020)\d{10}|01\d{9,10})/i);
  return match?.[1] ?? null;
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
  isWithdrawal: boolean,
): Promise<{ wallet: string | null; employee: string | null; source: string | null }> {
  if (textWallet) return { wallet: textWallet, employee: null, source: "sms_text" };
  if (!device || device === "unknown-device" || device === "unknown") return { wallet: null, employee: null, source: null };

  const { data: prefixRows, error: prefixError } = await supabaseAdmin.from("device_prefix_map")
    .select("wallet_number, sim_slot, employee")
    .eq("prefix", device)
    .eq("active", true);
  if (prefixError) console.error("device_prefix_map lookup failed", prefixError);

  const mappedRows = (prefixRows ?? []) as { wallet_number: string; sim_slot: number | null; employee: string | null }[];
  // device_prefix_map is the only trusted device -> SIM source. The old
  // wallet_device_map can contain retired Maven numbers after rotation, so a
  // missing V2 mapping must remain unresolved rather than showing a stale
  // wallet as fact.
  const rows = mappedRows.map((row) => ({ wallet: row.wallet_number, sim_slot: row.sim_slot, employee: row.employee, source: "device_prefix_map" }));

  if (!rows.length) return { wallet: null, employee: null, source: null };

  if (simSlot !== null && simSlot !== undefined) {
    const match = rows.find((r) => String(r.sim_slot ?? "") === String(simSlot));
    if (match) return { wallet: match.wallet, employee: match.employee, source: `${match.source}:sim_slot` };
  }

  const candidates = rows.filter((row, index) => row.wallet && rows.findIndex((other) => other.wallet === row.wallet) === index);
  if (candidates.length === 1) return { wallet: candidates[0].wallet, employee: candidates[0].employee, source: `${candidates[0].source}:single_candidate` };
  if (candidates.length === 0) return { wallet: null, employee: null, source: null };
  if (amount === null || balance === null) return { wallet: null, employee: null, source: null };

  // Both SIM candidates are independent reads. Run them together so wallet
  // resolution adds one database round trip instead of one round trip per SIM.
  const checks = await Promise.all(candidates.map(async (candidate) => {
    const { data: last } = await supabaseAdmin.from("inbound_sms")
      .select("balance_after")
      .or(`wallet_number.eq.${candidate.wallet},confirmed_wallet_number.eq.${candidate.wallet},receiver_number.eq.${candidate.wallet}`)
      .not("balance_after", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const previous = last?.balance_after == null ? null : Number(last.balance_after);
    const expected = previous === null ? null : isWithdrawal ? previous - amount : previous + amount;
    return { candidate, matches: expected !== null && Math.abs(expected - balance) <= 1 };
  }));
  const match = checks.find((check) => check.matches)?.candidate;
  if (match) return { wallet: match.wallet, employee: match.employee, source: `${match.source}:balance_continuity` };
  return { wallet: null, employee: null, source: null };
}

// Direction (incoming vs outgoing) is decided from the transaction clause only.
// Orange Cash appends promo ads after the receipt ("خصم 65% على اشتراك ...",
// "ادفع دلوقتي ..."), and matching words like "خصم" anywhere in the text
// mislabeled incoming payments as withdrawals (SMS #1010336). The receipt ends
// at "رقم المعاملة/العملية <digits>"; everything after it is ignored. Mirrors
// public.sms_core_text() / public.sms_direction() in the database.
function smsCoreText(message: string): string {
  const m = message.match(/^[\s\S]*?رقم\s*(?:المعاملة|العملية)\s*[:：]?\s*\d+/);
  return m ? m[0] : (message.split("\n\n")[0] ?? message);
}

function smsDirection(message: string): "in" | "out" | "notice" | "unknown" {
  const c = smsCoreText(message);
  if (/لديك\s*عملية\s*سحب/.test(c) && !/بمبلغ/.test(c)) return "notice";
  const isOut = /(عملية\s*سحب\s*ناجحة|تحويل\s*أموال\s*ناجحة|رسوم\s*السحب|رسوم\s*التحويل|تم\s*خصم|تم\s*سحب|تم\s*تحويل|لرقم|تحويل\s*(إلى|الي|الى))/.test(c)
    || /(withdraw|debit|paid out)/i.test(c);
  // "لتأكيد دفع مبلغ X ... ل <merchant>" (e.g. "Ubiqpay Technology Ltd.") is a
  // Vodafone Cash merchant/bill-pay confirmation for a SEPARATE merchant, not
  // a deposit to us. A 2026-10-13 change briefly classified it as "deposit" on
  // the theory that "لتأكيد" (confirm) implied a completed payment -- wrong,
  // per the account owner directly and independently per two different staff
  // (ahmedmano.solly, minafx2@gmail.com) each manually blocking an occurrence
  // of this exact message as irrelevant before the correction. Must stay
  // "unknown" like Orange's "ادفع X (merchant)" / Fawry's "To pay X for
  // merchant" -- never classified as a deposit, never shown as financial
  // evidence, never eligible for automation.
  const isIn = /(تم\s*استلام|استلمت|استقبلت|إيداع|ايداع|تم\s*اضافة|تم\s*إضافة)/.test(c)
    || /(received|deposit|credited)/i.test(c);
  if (isOut) return "out"; // a successful outgoing action always wins
  if (isIn) return "in";
  return "unknown";
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

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  // Device forwarders historically use `?device=ont8`, while newer setups
  // may use `/sms-inbound/ont8` or include `device` in the body. The old
  // implementation treated the function slug itself (`sms-inbound`) as the
  // device and therefore could not resolve the receiving wallet.
  const pathDevice = pathParts.findLast((part) => /^ont(?:10|[1-9])$/i.test(part));
  const routeDevice = normalizeDevice(url.searchParams.get("device") ?? pathDevice);

  // Several Android SMS-forwarder apps validate a webhook with GET or HEAD
  // before they will save it, even though real SMS delivery uses POST. Keep
  // those probes read-only and database-aware so the app accepts the URL
  // without creating a fake inbound_sms row.
  if (req.method === "GET" || req.method === "HEAD") {
    let body: Record<string, unknown> = {
      ok: true,
      receiver: "sms-inbound",
      device: routeDevice,
    };
    let status = 200;

    if (routeDevice !== "unknown-device") {
      const { data: registered, error: healthError } = await supabaseAdmin
        .from("device_registry")
        .select("device, active")
        .eq("device", routeDevice)
        .maybeSingle();

      if (healthError) {
        body = { ok: false, receiver: "sms-inbound", device: routeDevice, error: "database_unavailable" };
        status = 503;
      } else if (!registered?.active) {
        body = { ok: false, receiver: "sms-inbound", device: routeDevice, error: "device_not_active" };
        status = 404;
      } else {
        body = { ...body, database: true, registered: true };
      }
    }

    return req.method === "HEAD"
      ? new Response(null, { status, headers: jsonHeaders })
      : response(body, status);
  }

  if (req.method !== "POST") return response({ error: "Only GET, HEAD, and POST are allowed" }, 405);

  try {
    const payload = await readPayload(req);
    const device = normalizeDevice(
      url.searchParams.get("device") ?? pathDevice ?? firstValue(payload, "device", "device_name"),
    );
    const isConnectivityTest = req.headers.get("x-ontarget-test") === "true"
      || payload.test === true
      || String(payload.event ?? "").toLowerCase() === "webhook.test";
    if (isConnectivityTest) {
      const { data: registered, error: testError } = await supabaseAdmin
        .from("device_registry")
        .select("device, active")
        .eq("device", device)
        .maybeSingle();
      if (testError) return response({ ok: false, test: true, device, error: "database_unavailable" }, 503);
      if (!registered?.active) return response({ ok: false, test: true, device, error: "device_not_active" }, 404);
      return response({ ok: true, test: true, device, database: true, registered: true }, 200);
    }

    // "key"/"text" cover the device forwarder app's {time, key} envelope seen
    // in production from 2026-09-19; the rest keep older/other callers working.
    const messageValue = firstValue(payload, "message", "body", "text", "sms", "content", "msg", "key");
    const senderValue = firstValue(payload, "sender", "from", "sender_number", "phone", "address", "number");
    const walletValue = firstValue(payload, "wallet", "wallet_number", "receiver_number", "to");
    const amountValue = firstValue(payload, "amount", "value", "transfer_amount");
    const referenceValue = firstValue(payload, "trx_reference", "trx_ref", "transaction_id", "transactionId", "reference", "ref", "utr");
    const simSlotValue = payload.sim_slot === undefined || payload.sim_slot === null ? null : payload.sim_slot as string | number;

    const message = messageValue === null ? null : String(messageValue);
    if (!message) return response({ error: "message is required" }, 400);

    const providerValue = firstValue(payload, "provider", "network", "carrier") ?? detectNetworkFromMessage(message) ?? "ont1";

    const numericAmount = amountValue === null ? null : Number(String(amountValue).replace(/[^0-9.-]/g, ""));
    let amount = numericAmount !== null && Number.isFinite(numericAmount) ? numericAmount : null;
    if (amount === null) amount = extractAmount(message);
    const balance = extractBalance(message);

    let reference = referenceValue === null ? null : String(referenceValue);
    if (!reference) reference = extractReference(message);

    const explicitCategory = firstValue(payload, "sms_category", "category", "type");
    const categoryText = String(explicitCategory ?? "").trim().toLowerCase();
    const messageText = message.toLowerCase();
    // "تحويل أموال" (money transfer) alone appears in BOTH directions —
    // Orange Cash's outgoing confirmation is "عملية تحويل أموال ناجحة بمبلغ
    // X، لرقم Y، رسوم التحويل Z" (to a number, with a transfer fee) and its
    // incoming one is "تم استلام عملية تحويل أموال بمبلغ X من Y" (received,
    // from a sender) — confirmed live on SMS #1000826, an 11,300 EGP
    // outgoing transfer that the old بare-substring check miscategorized as
    // a deposit because it contains "تحويل أموال" too. "لرقم" (to number)
    // and "رسوم التحويل" (transfer fee) only ever appear on the outgoing
    // side; "تم استلام"/"إيداع" only ever appear on the incoming side.
    // "تحويل أموال ناجحة" (successful money transfer) is its own unambiguous
    // signal too, independent of whether لرقم/رسوم التحويل also survive in a
    // given template variant — "ناجحة" (successful, confirming the SENDER's
    // own action) never appears on the incoming "تم استلام" confirmation.
    const legacyWithdrawal = /(withdraw|withdrawal|debit|sent|paid out|سحب|خصم|تحويل إلى|تحويل الي|تم خصم|لرقم|رسوم\s*التحويل|تحويل\s*أموال\s*ناجحة)/i.test(messageText);
    const legacyIncoming = /(received|deposit|credited|credit|incoming|تم استلام|استقبلت|إيداع)/i.test(messageText);
    // Provider receipts that state an amount are classified from the receipt
    // clause only (see smsDirection). Peer-phone texts ("From : +20...") and
    // messages without a clear direction keep the legacy keyword rules.
    const hasAmountClause = /(بمبلغ|مبلغ)/.test(message) && !/From\s*:\s*\+/.test(message);
    const direction = hasAmountClause ? smsDirection(message) : "unknown";
    const isWithdrawal = direction === "out" ? true : direction === "in" ? false : legacyWithdrawal;
    const isIncoming = direction === "in" ? true : direction === "out" ? false : legacyIncoming;

    // "جالك طلب تحويل بمبلغ X ... افتح تطبيق أنا فودافون علشان تقبل أو ترفض
    // الطلب" is Vodafone Cash's PENDING incoming-transfer-request notice --
    // the money has not moved, the wallet owner still has to accept it in the
    // app. Confirmed live on sender 01067348969: 8 occurrences across
    // different fabricated amounts (158/150/151/100/80/74 EGP), only ONE real
    // "تم استلام" deposit from that same sender ever landed (45 EGP, a
    // different amount). One of the fake-amount request SMS (#1014624, 74
    // EGP) was used as "SMS evidence" by staff to manually override an
    // automation-engine-blacklist auto-decline back to PAID on tx #138501449
    // -- i.e. this misclassification already caused one blacklisted sender's
    // declined transaction to be paid out. Must stay "unknown": never a
    // deposit/withdrawal, never shown as financial evidence, never wallet-
    // resolved, never eligible for automation or manual-match "evidence".
    const isPendingTransferRequest = /طلب\s*تحويل/.test(message) && /(تقبل|ترفض|accept|reject)/i.test(message);

    // "لتأكيد دفع مبلغ X ... ل Ubiqpay Technology Ltd." is Vodafone Cash's
    // merchant/bill-pay confirmation for a SEPARATE merchant (see the
    // 2026-10-13/14 revert history below for isWithdrawal/isIncoming) --
    // that revert only removed it as an explicit isIncoming SIGNAL, but
    // never stopped the UNCONDITIONAL fallback two lines below ((amount !==
    // null && wallet !== null) => "deposit") from reaching the same wrong
    // answer by a different route: this message has a real amount and, once
    // the device happens to map to exactly one wallet, a real wallet too.
    // Confirmed live: SMS #1014822 (1400 EGP) landed sms_category='deposit'
    // AGAIN days after the revert, already manually blocked by an operator.
    // Must never resolve a wallet or classify as deposit, same as
    // isPendingTransferRequest right above.
    const isMerchantBillPayConfirmation = /لتأكيد\s*دفع\s*مبلغ/.test(message);
    const isNonDepositConfirmation = isPendingTransferRequest || isMerchantBillPayConfirmation;

    // A genuine wallet-provider deposit notification always originates from a
    // regulated sender ID (e.g. "OrangeCash") — Egyptian carriers never let a
    // real subscriber MSISDN send as one. A leading "+" on the raw envelope
    // sender means the device-forwarder app captured a genuine peer-to-peer
    // phone origin: someone typed the message themselves and sent it like a
    // normal text. Confirmed live via SMS #1000876/#1000868 — hand-crafted
    // "deposit" messages with the balance line left blank (unforgeable
    // without knowing the real live balance), sent from +201200793615, used
    // to get a 5,000 EGP and a 950 EGP transaction auto-approved with no real
    // payment ever received.
    const rawSender = senderValue === null ? extractSenderNumber(message) : String(senderValue).trim();
    const isPeerPhoneSender = rawSender !== null && /^\+\d{8,15}$/.test(rawSender);

    const textWallet = walletValue !== null ? String(walletValue) : extractWalletFromText(message);
    // Only fall back to a device-mapped wallet when the message already
    // looks financial (an explicit wallet found in the text is fine either
    // way — that's real evidence, not a guess). Otherwise a promotional
    // message with no deposit/withdrawal wording at all still ends up
    // carrying a real wallet number just because its device has exactly one
    // mapped SIM, polluting an "unknown" row with data that implies evidence
    // that was never actually there.
    const resolved = (!isNonDepositConfirmation && (isIncoming || isWithdrawal || amount !== null || textWallet))
      ? await resolveWallet(device, simSlotValue, textWallet, amount, balance, isWithdrawal).catch(() => ({ wallet: null, employee: null, source: null }))
      : { wallet: null, employee: null, source: null };
    const wallet = resolved.wallet;

    const smsCategory = isNonDepositConfirmation
      ? "unknown"
      : ["deposit", "received", "income", "withdrawal", "expense"].includes(categoryText)
        ? categoryText
        : isWithdrawal
          ? "withdrawal"
          : (isIncoming || (amount !== null && wallet !== null))
            ? "deposit"
            : "unknown";

    // Genuine provider chatter that isn't a transaction (balance pings,
    // promo/loyalty texts, envelope-only fragments) goes to its own table
    // instead of inbound_sms — but only when it's actually from the provider.
    // A peer-phone sender never gets the benefit of the doubt here: it stays
    // in inbound_sms, blocked, where fraud review already looks for it.
    if (smsCategory === "unknown" && !isPeerPhoneSender) {
      const notificationType = classifyNotification(message);
      if (notificationType) {
        const { data: note, error: noteError } = await supabaseAdmin
          .from("sms_provider_notifications")
          .insert({
            device_name: device,
            provider: String(providerValue),
            sender_number: rawSender,
            sender_name: (firstValue(payload, "sender_name", "name") === null ? null : String(firstValue(payload, "sender_name", "name"))) ?? extractSenderName(message),
            message,
            sms_first_line: message.split(/\r?\n/)[0]?.slice(0, 500) ?? message,
            notification_type: notificationType,
            raw_payload: payload,
            received_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (noteError) {
          console.error("sms_provider_notifications insert failed", noteError);
          return response({ error: "Could not store notification" }, 500);
        }
        return response({ ok: true, notification: true, notification_type: notificationType, id: note.id }, 201);
      }
    }

    // Write both the live column names the panel's matching logic reads
    // (sender_number, receiver_number/wallet_number, trx_id, sms_category)
    // and the older aliases (sender, wallet, trx_reference) some legacy
    // reporting still queries — cheap to keep both in sync.
    const row = {
      // rawSender already resolves to the text-extracted phone when the
      // caller didn't supply one (see above) -- using senderValue directly
      // here discarded that extraction and left sender_number/sender null
      // for every Vodafone deposit despite the number being right there in
      // the message.
      sender: rawSender,
      sender_number: rawSender,
      sender_name: (firstValue(payload, "sender_name", "name") === null ? null : String(firstValue(payload, "sender_name", "name"))) ?? extractSenderName(message) ?? extractVodafoneSenderName(message),
      message,
      sms_first_line: message.split(/\r?\n/)[0]?.slice(0, 500) ?? message,
      wallet,
      receiver_number: wallet,
      wallet_number: wallet,
      device_prefix: device === "unknown-device" ? null : device,
      resolved_employee: resolved.employee,
      wallet_resolution_source: resolved.source,
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
      is_blocked: isPeerPhoneSender,
      notes: isPeerPhoneSender ? "auto_blocked_peer_phone_sender_not_provider" : null,
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

    if (balance !== null && smsCategory !== "withdrawal") {
      const thresholdTask = switchWalletImmediately(wallet, balance, data.id, detectNetworkFromMessage(message) ?? providerValue).catch((thresholdError) =>
        console.error("immediate wallet threshold switch failed", thresholdError instanceof Error ? thresholdError.message : thresholdError)
      );
      try {
        // @ts-ignore -- EdgeRuntime is a Supabase/Deno Deploy global.
        EdgeRuntime.waitUntil(thresholdTask);
      } catch {
        // The webhook response remains independent from the provider switch.
      }
    }

    if (smsCategory === "withdrawal") {
      const alertTask = sendWithdrawalAlertEmail(row, data.id).catch((err) =>
        console.error("withdrawal alert email failed", err instanceof Error ? err.message : err)
      );
      try {
        // @ts-ignore -- EdgeRuntime is a Supabase/Deno Deploy global, not in the Deno lib types.
        EdgeRuntime.waitUntil(alertTask);
      } catch {
        // Runtime without EdgeRuntime.waitUntil (e.g. local dev) -- the
        // response below still returns promptly either way; this only
        // means the mail send races the function's teardown locally.
      }
    }

    return response({ ok: true, id: data.id }, 201);
  } catch (error) {
    console.error("sms-inbound request failed", error);
    return response({ error: "Invalid request" }, 400);
  }
});
