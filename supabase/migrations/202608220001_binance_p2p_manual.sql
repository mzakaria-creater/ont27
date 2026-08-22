-- Binance P2P phase 1: manual-only controls. This migration intentionally
-- contains no trigger, cron job, queue consumer, or automatic execution path.
create extension if not exists supabase_vault with schema vault;

alter table public.binance_treasury_config
  add column if not exists p2p_enabled boolean not null default false,
  add column if not exists p2p_asset text not null default 'USDT',
  add column if not exists p2p_fiat text not null default 'EGP',
  add column if not exists max_p2p_order_amount numeric,
  add column if not exists max_p2p_24h_amount numeric,
  add column if not exists api_key_secret_id uuid,
  add column if not exists api_secret_secret_id uuid;

alter table public.binance_treasury_config
  drop constraint if exists binance_p2p_limits_positive,
  add constraint binance_p2p_limits_positive check (
    (max_p2p_order_amount is null or max_p2p_order_amount > 0) and
    (max_p2p_24h_amount is null or max_p2p_24h_amount > 0)
  ),
  drop constraint if exists binance_p2p_enable_requires_limits,
  add constraint binance_p2p_enable_requires_limits check (
    not p2p_enabled or (
      max_p2p_order_amount is not null and max_p2p_24h_amount is not null and
      api_key_secret_id is not null and api_secret_secret_id is not null
    )
  );

create table if not exists public.binance_p2p_execution_log (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  actor_id uuid not null,
  actor_name text not null,
  side text not null check (side in ('BUY', 'SELL')),
  asset text not null,
  fiat text not null,
  fiat_amount numeric not null check (fiat_amount > 0),
  advertisement_number text,
  confirmation_text text not null,
  confirmed_at timestamptz not null,
  status text not null check (status in ('REJECTED', 'FAILED', 'SUCCEEDED', 'UNAVAILABLE')),
  provider_order_number text,
  provider_http_status integer,
  provider_result jsonb,
  failure_code text,
  created_at timestamptz not null default now()
);
create index if not exists binance_p2p_log_rolling_limit_idx
  on public.binance_p2p_execution_log (confirmed_at desc)
  where status in ('SUCCEEDED');
alter table public.binance_p2p_execution_log enable row level security;

-- Vault access is service-role-only. The application never selects decrypted
-- secrets and configuration responses expose only a has_credentials boolean.
create or replace function public.set_binance_p2p_credentials(p_api_key text, p_api_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare key_id uuid; secret_id uuid; old_key uuid; old_secret uuid;
begin
  if length(trim(p_api_key)) < 16 or length(trim(p_api_secret)) < 16 then
    raise exception 'invalid_binance_credentials';
  end if;
  select api_key_secret_id, api_secret_secret_id into old_key, old_secret
    from public.binance_treasury_config where id = true for update;
  key_id := vault.create_secret(trim(p_api_key), 'binance_p2p_api_key_' || gen_random_uuid());
  secret_id := vault.create_secret(trim(p_api_secret), 'binance_p2p_api_secret_' || gen_random_uuid());
  update public.binance_treasury_config set api_key_secret_id = key_id,
    api_secret_secret_id = secret_id, p2p_enabled = false, updated_at = now() where id = true;
  if old_key is not null then delete from vault.secrets where id = old_key; end if;
  if old_secret is not null then delete from vault.secrets where id = old_secret; end if;
end $$;
revoke all on function public.set_binance_p2p_credentials(text, text) from public, anon, authenticated;
grant execute on function public.set_binance_p2p_credentials(text, text) to service_role;

create or replace function public.get_binance_p2p_credentials()
returns table(api_key text, api_secret text)
language sql security definer set search_path = public, vault as $$
  select k.decrypted_secret, s.decrypted_secret
  from public.binance_treasury_config c
  join vault.decrypted_secrets k on k.id = c.api_key_secret_id
  join vault.decrypted_secrets s on s.id = c.api_secret_secret_id
  where c.id = true
$$;
revoke all on function public.get_binance_p2p_credentials() from public, anon, authenticated;
grant execute on function public.get_binance_p2p_credentials() to service_role;

insert into public.role_page_permissions
  (role_key, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export)
select r.role_key, 'binance_p2p_config', r.role_key = 'super_admin', false,
  r.role_key = 'super_admin', false, false, false
from public.app_roles r
on conflict (role_key, page_key) do update set
  can_view = excluded.can_view, can_create = false, can_edit = excluded.can_edit,
  can_delete = false, can_approve = false, can_export = false;
