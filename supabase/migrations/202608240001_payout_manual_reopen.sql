alter table public.maven_payout_transactions
  add column if not exists manual_status_override boolean not null default false,
  add column if not exists manual_reopened_at timestamptz,
  add column if not exists manual_reopened_by text;

