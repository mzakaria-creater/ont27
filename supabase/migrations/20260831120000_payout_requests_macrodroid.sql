-- Withdrawal requests queued for an explicit operator approval before USSD.
create table if not exists public.payout_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id text, merchant_name text,
  master_merchant text check (master_merchant in ('NGPay','PayFuture')),
  wallet_number text not null,
  amount numeric(18,2) not null check (amount > 0),
  note text,
  device text not null default 'ont1' check (device ~ '^ont[1-7]$'),
  status text not null default 'pending' check (status in ('pending','approved','executing','completed','failed','rejected')),
  requested_by text, approved_by text, rejected_by text, rejection_note text,
  webhook_url text, webhook_sent_at timestamptz, webhook_status int, webhook_error text,
  proof_sms text, proof_ref text, balance_after numeric(18,2), screenshot_url text,
  created_at timestamptz not null default now(), approved_at timestamptz, completed_at timestamptz, failed_at timestamptz
);
create index if not exists idx_pr_status on public.payout_requests(status, created_at desc);
create index if not exists idx_pr_merchant on public.payout_requests(merchant_id, created_at desc);
create index if not exists idx_pr_device on public.payout_requests(device);
create index if not exists idx_pr_wallet on public.payout_requests(wallet_number);
alter table public.payout_requests enable row level security;
do $$ begin
  create policy payout_requests_service_role on public.payout_requests for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

-- The URL is not seeded: a placeholder webhook is unsafe. Store PINs in a
-- secret manager and reference them by name, never as plaintext in Postgres.
create table if not exists public.device_macrodroid_urls (
  device text primary key check (device ~ '^ont[1-7]$'),
  macro_url text not null,
  pin_secret_ref text not null,
  active boolean not null default true
);
alter table public.device_macrodroid_urls enable row level security;
do $$ begin
  create policy device_macrodroid_service_role on public.device_macrodroid_urls for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;
