create table if not exists public.settlement_merchant_payments (
  id uuid primary key default gen_random_uuid(), merchant text not null,
  settlement_month date not null, amount numeric(18,2) not null check (amount > 0),
  blocked_percent numeric(7,4) not null default 0 check (blocked_percent between 0 and 100),
  usdt_rate numeric(18,6), payment_fee numeric(18,2) not null default 0, service_fee numeric(18,2) not null default 0,
  note text, paid_by text, paid_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index if not exists settlement_merchant_payments_month_idx on public.settlement_merchant_payments(settlement_month, merchant);
alter table public.settlement_merchant_payments enable row level security;
revoke all on public.settlement_merchant_payments from anon, authenticated;
drop policy if exists service_role_full_access_settlement_payments on public.settlement_merchant_payments;
create policy service_role_full_access_settlement_payments on public.settlement_merchant_payments for all to service_role using (true) with check (true);
