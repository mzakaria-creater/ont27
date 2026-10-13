-- Merchant groups (Partners & Groups) and merchant tier. No seed data.
create table if not exists public.merchant_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  color text not null default '#3b82f6',
  commission_rate numeric(6,3) not null default 0 check (commission_rate >= 0 and commission_rate <= 100),
  routing_priority integer not null default 100,
  settlement_period text not null default 'T+1' check (settlement_period in ('T+0','T+1','T+2','T+3')),
  daily_volume_cap numeric(18,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists merchant_groups_name_uniq on public.merchant_groups (lower(name));
alter table public.merchant_groups enable row level security;

alter table public.merchants add column if not exists group_id uuid references public.merchant_groups(id) on delete set null;
alter table public.merchants add column if not exists tier text check (tier in ('bronze','silver','gold','platinum'));
create index if not exists merchants_group_idx on public.merchants (group_id);
