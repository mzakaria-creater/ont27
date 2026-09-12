-- Payment account assignment and wallet queue rotation settings.
alter table public.payment_pools
  add column if not exists rotation_enabled boolean not null default false,
  add column if not exists rotation_interval_minutes integer not null default 60,
  add column if not exists allocation_strategy text not null default 'next_wallet',
  add column if not exists next_rotation_at timestamptz;

alter table public.payment_pools
  drop constraint if exists payment_pools_rotation_interval_check;
alter table public.payment_pools
  add constraint payment_pools_rotation_interval_check
  check (rotation_interval_minutes between 5 and 10080);

alter table public.payment_pools
  drop constraint if exists payment_pools_allocation_strategy_check;
alter table public.payment_pools
  add constraint payment_pools_allocation_strategy_check
  check (allocation_strategy in ('next_wallet', 'least_loaded', 'highest_balance'));

create index if not exists payment_pools_rotation_idx
  on public.payment_pools (rotation_enabled, next_rotation_at);
