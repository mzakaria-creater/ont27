-- Country-specific payment-method availability and direct merchant assignment.
-- Operational writes go through the authenticated server API; no browser role
-- receives direct table access.
create table if not exists public.payment_method_countries (
  id uuid primary key default gen_random_uuid(),
  payment_method_id uuid not null references public.payment_methods(id) on delete cascade,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_method_id, country_code, currency_code)
);

create table if not exists public.payment_method_country_merchants (
  id uuid primary key default gen_random_uuid(),
  method_country_id uuid not null references public.payment_method_countries(id) on delete cascade,
  merchant_hierarchy_id bigint not null references public.merchants_hierarchy(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (method_country_id, merchant_hierarchy_id)
);

create index if not exists payment_method_countries_country_idx
  on public.payment_method_countries (country_code, is_active);
create index if not exists payment_method_country_merchants_merchant_idx
  on public.payment_method_country_merchants (merchant_hierarchy_id, is_active);

alter table public.payment_method_countries enable row level security;
alter table public.payment_method_country_merchants enable row level security;
revoke all on public.payment_method_countries from anon, authenticated;
revoke all on public.payment_method_country_merchants from anon, authenticated;
grant all on public.payment_method_countries to service_role;
grant all on public.payment_method_country_merchants to service_role;
