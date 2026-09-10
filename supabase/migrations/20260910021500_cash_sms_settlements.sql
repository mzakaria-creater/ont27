create table if not exists public.cash_sms_settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_at timestamptz not null default now(),
  direction text not null check (direction in ('in', 'out')),
  recipient_name text not null check (char_length(trim(recipient_name)) between 2 and 120),
  amount numeric not null check (amount > 0),
  method text not null check (char_length(trim(method)) between 2 and 80),
  wallet text,
  sms_id bigint references public.inbound_sms(id) on delete set null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists cash_sms_settlements_at_idx on public.cash_sms_settlements (settlement_at desc);
create index if not exists cash_sms_settlements_direction_idx on public.cash_sms_settlements (direction);
alter table public.cash_sms_settlements enable row level security;
