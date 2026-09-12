-- Payment-link routing: merchant/client identity, allowed methods, wallet pool
-- allocation and merchant return URL.
alter table public.payment_links
  add column if not exists client_name text,
  add column if not exists client_reference text,
  add column if not exists return_url text,
  add column if not exists payment_method_codes text[] not null default '{}',
  add column if not exists wallet_pool_id uuid references public.payment_pools(id) on delete set null,
  add column if not exists allocation_mode text not null default 'single_queue',
  add column if not exists multi_wallet_threshold numeric;

alter table public.payment_links
  drop constraint if exists payment_links_allocation_mode_check;

alter table public.payment_links
  add constraint payment_links_allocation_mode_check
  check (allocation_mode in ('single_queue', 'multi_wallet'));

alter table public.payment_links
  drop constraint if exists payment_links_multi_wallet_threshold_check;

alter table public.payment_links
  add constraint payment_links_multi_wallet_threshold_check
  check (multi_wallet_threshold is null or multi_wallet_threshold > 0);

create index if not exists payment_links_wallet_pool_idx
  on public.payment_links(wallet_pool_id)
  where wallet_pool_id is not null;
