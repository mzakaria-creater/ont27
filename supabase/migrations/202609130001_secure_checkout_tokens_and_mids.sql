-- Secure hosted-checkout identity for API v3 compatibility.
-- Raw tokens are returned once at creation time; only their SHA-256 digest is stored.

alter table public.payment_links
  add column if not exists checkout_token_hash text unique;

alter table public.checkout_sessions
  add column if not exists checkout_token_hash text unique;

alter table public.master_merchants
  add column if not exists mid text;

alter table public.merchants_hierarchy
  add column if not exists mid text;

update public.master_merchants
set mid = 'MID-' || upper(regexp_replace(coalesce(code, name), '[^a-zA-Z0-9]+', '-', 'g'))
where mid is null;

update public.merchants_hierarchy
set mid = 'MID-' || upper(regexp_replace(coalesce(name, 'SUB-' || id::text), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id::text
where mid is null;

create unique index if not exists master_merchants_mid_key on public.master_merchants(mid) where mid is not null;
create unique index if not exists merchants_hierarchy_mid_key on public.merchants_hierarchy(mid) where mid is not null;
create index if not exists checkout_sessions_token_hash_idx on public.checkout_sessions(checkout_token_hash) where checkout_token_hash is not null;

