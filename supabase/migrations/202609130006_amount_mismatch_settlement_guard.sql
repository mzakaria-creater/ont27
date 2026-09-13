-- Financial safety: a locally edited amount must be confirmed by Maven before
-- it can be included in a merchant settlement.
alter table if exists public.maven_transactions
  add column if not exists provider_amount numeric,
  add column if not exists local_amount numeric,
  add column if not exists amount_sync_status text not null default 'matched',
  add column if not exists amount_mismatch_reason text,
  add column if not exists amount_confirmed_at timestamptz,
  add column if not exists amount_confirmed_by text,
  add column if not exists settlement_blocked boolean not null default false;

alter table if exists public.maven_transactions
  drop constraint if exists maven_transactions_amount_sync_status_check;

alter table if exists public.maven_transactions
  add constraint maven_transactions_amount_sync_status_check
  check (amount_sync_status in ('matched', 'mismatch', 'pending_confirmation'));

update public.maven_transactions
set provider_amount = coalesce(provider_amount, amount),
    local_amount = coalesce(local_amount, amount),
    amount_sync_status = coalesce(amount_sync_status, 'matched'),
    settlement_blocked = coalesce(settlement_blocked, false)
where provider_amount is null or local_amount is null or settlement_blocked is null;

create index if not exists idx_maven_transactions_settlement_amount_mismatch
  on public.maven_transactions (merchant, settlement_blocked, amount_sync_status)
  where settlement_blocked = true and amount_sync_status = 'mismatch';

-- Refuse creating a settlement payment while any transaction for that merchant
-- has an unconfirmed local/provider amount difference.
create or replace function public.guard_settlement_amount_mismatch(p_merchant text)
returns table (allowed boolean, mismatch_count bigint)
language plpgsql security definer set search_path = public
as $$
begin
  return query
  select count(*) = 0, count(*)
  from public.maven_transactions tx
  where lower(coalesce(tx.merchant, '')) = lower(trim(p_merchant))
    and tx.settlement_blocked = true
    and tx.amount_sync_status = 'mismatch';
end;
$$;

revoke all on function public.guard_settlement_amount_mismatch(text) from public, anon, authenticated;
grant execute on function public.guard_settlement_amount_mismatch(text) to service_role;
