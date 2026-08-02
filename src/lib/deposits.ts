// Shared deposit types + formatting for maven_transactions rows.
// created_utc/modified_utc are TEXT in two formats ("2026-07-22 15:07:02" and
// ISO with Z) — parse defensively and prefer the timestamptz columns.

export interface DepositRow {
  tx_id: number
  guid: string | null
  ontarget_ref: string | null
  merchant_tx_reference: string | null
  status: string
  amount: number | null
  currency: string | null
  sender_name: string | null
  sender_number: string | null
  payment_method: string | null
  gateway: string | null
  merchant: string | null
  sub_merchant: string | null
  master_merchant: string | null
  manual_entry: boolean | null
  approved_by: string | null
  to_account_number: string | null
  receiving_wallet: string | null
  proof_image_url: string | null
  sms?: { id: number; sender_name: string | null; amount: number | null; balance_after: number | null; received_at: string | null } | null
  first_seen_at: string | null
  last_status_change: string | null
  created_utc: string | null
}

export interface DepositDetail extends DepositRow {
  to_account_number: string | null
  to_account_name: string | null
  to_bank: string | null
  agent_name: string | null
  country: string | null
  request_type: string | null
  response_message: string | null
  proof_image_url: string | null
  receiving_wallet: string | null
  email: string | null
  fees: number | null
  commission: number | null
  modified_utc: string | null
  updated_at: string | null
  manual_entry_note: string | null
  manual_entry_by: string | null
}

export interface DepositStats {
  total: number
  pending: number
  day: { paid: { count: number; volume: number }; declined: number }
  week: { paid: { count: number; volume: number } }
  recent: DepositRow[]
}

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: 'معلّق', cls: 'st-pending' },
  PAID: { label: 'مدفوع', cls: 'st-paid' },
  APPROVED: { label: 'مُعتمد', cls: 'st-paid' },
  DECLINED: { label: 'مرفوض', cls: 'st-declined' },
  EXPIRED: { label: 'منتهي', cls: 'st-dim' },
  EXPIRED_LOCAL: { label: 'منتهي (محلي)', cls: 'st-dim' },
  UNDERPAID: { label: 'دفع ناقص', cls: 'st-under' },
}

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, cls: 'st-dim' }
}

export function parseUtcText(value: string | null | undefined): Date | null {
  if (!value) return null
  let s = value.trim()
  if (!s) return null
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T')
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

// en-GB keeps the dd/MM HH:mm order stable inside RTL table cells.
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

// Prefer created_utc (the REAL transaction time at the provider) over
// first_seen_at (when OUR sync first saw the row — the migration stamped
// thousands of rows with the same first_seen_at).
export function depositTime(row: { first_seen_at?: string | null; created_utc?: string | null }): string {
  const d = parseUtcText(row.created_utc) ?? parseUtcText(row.first_seen_at)
  return d ? timeFmt.format(d) : '—'
}

const moneyFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function money(amount: number | null | undefined, currency?: string | null): string {
  if (amount == null) return '—'
  return `${moneyFmt.format(Number(amount))} ${currency ?? ''}`.trim()
}
