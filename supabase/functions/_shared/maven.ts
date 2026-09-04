const ROOT = "https://bo.maven-consulting.co";
const PAGE_SIZE = 100;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export type MavenRow = Record<string, any>;

export function cookiesFrom(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g).flatMap((c) => c.split("\n"))
    .map((c) => c.split(";")[0].trim()).filter(Boolean);
}
export function mergeCookies(...lists: string[][]): string {
  const map: Record<string, string> = {};
  for (const list of lists) for (const cookie of list) {
    const i = cookie.indexOf("="); if (i > 0) map[cookie.slice(0, i)] = cookie;
  }
  return Object.values(map).join("; ");
}
export function fmtDay(d: Date, time: string) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${time}`;
}
export function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = value.match(/\/Date\((\d+)\)\//);
  if (ms) return new Date(Number(ms[1])).toISOString().replace("T", " ").slice(0, 19);
  return value.trim().replace("T", " ").slice(0, 19);
}
export async function login(username: string, password: string, area = "Supplier"): Promise<string> {
  const page = await fetch(`${ROOT}/${area}/Login`, { headers: { accept: "text/html" }, redirect: "follow" });
  const html = await page.text();
  const token = html.match(/name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]*)\"/i)?.[1];
  const form = new URLSearchParams({ Username: username, Password: password });
  if (token) form.set("__RequestVerificationToken", token);
  const response = await fetch(`${ROOT}/${area}/Login/PostV2`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: mergeCookies(cookiesFrom(page.headers.get("set-cookie"))), origin: ROOT, referer: `${ROOT}/${area}/Login` },
    body: form,
  });
  const location = response.headers.get("location") ?? "";
  if (response.status !== 302 || location.includes("/Error/")) throw new Error(`Maven login failed (${response.status})`);
  return mergeCookies(cookiesFrom(page.headers.get("set-cookie")), cookiesFrom(response.headers.get("set-cookie")));
}
export async function listTransactions(cookie: string, start: number, from: string, to: string, area = "Supplier") {
  const body = new URLSearchParams({ draw: "1", start: String(start), length: String(PAGE_SIZE), "search[value]": "", "search[regex]": "false", "order[0][column]": "26", "order[0][dir]": "desc", StartCreatedDate: from, EndCreatedDate: to, DbFieldName_1: "Guid", FilterType_1: "contains", SearchVal_1: "", DbFieldName_2: "Guid", FilterType_2: "contains", SearchVal_2: "", DbFieldName_3: "Guid", FilterType_3: "contains", SearchVal_3: "", DbFieldName_4: "Guid", FilterType_4: "contains", SearchVal_4: "", IsTxnWithSS: "false" });
  const response = await fetch(`${ROOT}/${area}/Transactions/GetP2PPendingTransactions`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", accept: "application/json, text/javascript, */*; q=0.01", referer: `${ROOT}/${area}/Transactions/GetP2PPendingTransactionList`, origin: ROOT }, body });
  const text = await response.text();
  if (!response.ok || /<html[\s>]/i.test(text)) throw new Error(`Maven list failed (${response.status})`);
  const payload = JSON.parse(text) as { data?: MavenRow[]; recordsTotal?: number; errorMessage?: string | null };
  if (payload.errorMessage) throw new Error(payload.errorMessage);
  return { rows: payload.data ?? [], total: Number(payload.recordsTotal ?? 0) };
}
export function toDbRow(row: MavenRow) {
  const txId = Number(row.TransactionId ?? 0); if (!txId) return null;
  const candidates = [row.BankWalletNumber, row.BankAccountNumber, row.AccountNumber, row.ToBankAccountNumber];
  const account = candidates.find((v) => typeof v === "string" && v.trim() && v.trim().toUpperCase() !== "NA")?.trim() ?? null;
  const created = parseDate(row.CreatedDateUTC) ?? parseDate(row.CreatedDate);
  const modified = parseDate(row.ModifiedDateUTC) ?? parseDate(row.ModifiedDate);
  const image = Array.isArray(row.ImageUrl) ? row.ImageUrl[0] ?? null : null;
  return { tx_id: txId, guid: row.Guid ?? null, status: String(row.Status ?? "PENDING").toUpperCase(), amount: Number(row.Amount ?? 0), currency: row.Currency ?? "EGP", sender_name: row.FirstName ?? row.AccountName ?? null, sender_number: row.PhoneNo ?? null, to_account_number: account, receiving_wallet: account, to_account_name: row.BankAccountName ?? null, to_bank: row.ToBankName ?? row.BankName ?? null, payment_method: row.BankName ?? row.iPayinfo ?? null, gateway: row.Gateway ?? null, merchant: row.MerchantName ?? null, sub_merchant: row.SiteName ?? null, master_merchant: /payfuture/i.test(String(row.SiteName ?? "")) ? "PayFuture" : "NGPay", agent_name: row.AgentName ?? null, country: row.Country ?? null, request_type: row.RequestType ?? null, response_message: row.Response ?? row.Description ?? null, merchant_tx_reference: row.Reference1 ?? null, created_utc: created, modified_utc: modified, proof_image_url: image, provider_commission: Number.isFinite(Number(row.Commision)) ? Number(row.Commision) : null, raw: row, maven_raw_row: row };
}
export async function sha256(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
