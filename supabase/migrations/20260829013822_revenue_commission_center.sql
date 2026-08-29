-- Revenue & Commission Center. This is an analytical/bookkeeping layer only:
-- it has no trigger, cron, payout call, or balance mutation path.
create table if not exists public.revenue_share_rules (
  id uuid primary key default gen_random_uuid(),
  beneficiary_type text not null check (beneficiary_type in ('team','partner','owner')),
  beneficiary_name text not null check (length(trim(beneficiary_name)) between 2 and 160),
  share_percent numeric(7,4) not null check (share_percent > 0 and share_percent <= 100),
  merchant text,
  effective_from date not null default current_date,
  effective_to date,
  active boolean not null default true,
  notes text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists public.financial_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null default current_date,
  entry_type text not null check (entry_type in ('income','expense','capital_injection','distribution','adjustment')),
  category text not null check (length(trim(category)) between 2 and 100),
  description text not null check (length(trim(description)) between 2 and 500),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null default 'EGP' check (currency in ('EGP','USD','EUR','USDT')),
  merchant text,
  beneficiary text,
  reference text,
  status text not null default 'posted' check (status in ('draft','posted','void')),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists revenue_share_rules_scope_idx on public.revenue_share_rules (active, merchant, effective_from);
create index if not exists financial_ledger_entries_date_idx on public.financial_ledger_entries (entry_date desc, status);

alter table public.revenue_share_rules enable row level security;
alter table public.financial_ledger_entries enable row level security;
revoke all on public.revenue_share_rules from anon, authenticated;
revoke all on public.financial_ledger_entries from anon, authenticated;

insert into public.role_page_permissions
  (role_key,page_key,can_view,can_create,can_edit,can_delete,can_approve,can_export)
select role_key, 'revenue_center',
  role_key in ('super_admin','owner','admin','finance_admin','treasury_admin'),
  role_key in ('super_admin','owner','finance_admin'),
  role_key in ('super_admin','owner','finance_admin'),
  role_key in ('super_admin','owner'),
  false,
  role_key in ('super_admin','owner','admin','finance_admin','treasury_admin')
from public.app_roles
on conflict (role_key,page_key) do update set
  can_view=excluded.can_view, can_create=excluded.can_create, can_edit=excluded.can_edit,
  can_delete=excluded.can_delete, can_approve=false, can_export=excluded.can_export;
