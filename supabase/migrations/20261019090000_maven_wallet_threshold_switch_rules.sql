-- Owner-confirmed live Maven wallet switch rules.
-- The rule is evaluated from V2 inbound SMS and executes only after the
-- current Maven bank is verified immediately before the provider write.
create table if not exists public.maven_wallet_threshold_switch_rules (
  id uuid primary key default gen_random_uuid(),
  bank_id text not null,
  merchant text not null,
  payment_type text not null,
  source_wallet text not null,
  target_wallet text not null,
  amount_threshold numeric not null check (amount_threshold > 0),
  amount_received_since_check numeric not null default 0,
  active boolean not null default true,
  status text not null default 'active' check (status in ('active', 'switched', 'error', 'paused')),
  last_checked_at timestamptz not null default now(),
  switched_at timestamptz,
  last_error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maven_wallet_threshold_switch_distinct_wallets check (source_wallet <> target_wallet)
);

create unique index if not exists maven_wallet_threshold_switch_bank_idx
  on public.maven_wallet_threshold_switch_rules (bank_id)
  where active;
create index if not exists maven_wallet_threshold_switch_active_idx
  on public.maven_wallet_threshold_switch_rules (active, status, updated_at desc);

alter table public.maven_wallet_threshold_switch_rules enable row level security;
drop policy if exists maven_wallet_threshold_switch_service_role_access on public.maven_wallet_threshold_switch_rules;
create policy maven_wallet_threshold_switch_service_role_access
  on public.maven_wallet_threshold_switch_rules
  for all to service_role using (true) with check (true);

-- This is the owner's confirmed MelBet Vodafone Cash rule.
insert into public.maven_wallet_threshold_switch_rules (
  bank_id, merchant, payment_type, source_wallet, target_wallet,
  amount_threshold, created_by
)
values (
  '868', 'NGPay-MelBet-Prod', 'Vodafone Cash', '01029476503', '01027310612',
  8000, 'owner-confirmed'
)
on conflict do nothing;
