-- CRM: learn phone-less SMS sender names from clients with more than one
-- PAID transaction. Safe to re-run. Backfill is intentionally left commented
-- so it only runs after explicit owner approval.

create table if not exists public.crm_sms_name_links (
  id bigserial primary key,
  name text not null,
  phone10 text not null,
  tx_id bigint not null,
  sms_id bigint,
  status text not null check (status in ('linked','conflict','skipped')),
  detail text,
  created_at timestamptz not null default now()
);

create unique index if not exists crm_sms_name_links_uniq
  on public.crm_sms_name_links (lower(name), phone10, tx_id);

create index if not exists crm_sms_name_links_status_idx
  on public.crm_sms_name_links (status, created_at desc);

alter table public.crm_sms_name_links enable row level security;
revoke all on table public.crm_sms_name_links from anon, authenticated;

create or replace function public.learn_sms_name_for_tx(p_tx bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $f$
declare
  v_tx public.maven_transactions%rowtype;
  v_key text;
  v_paid int;
  v_sms public.inbound_sms%rowtype;
  v_name text;
  v_conflict boolean;
  v_client uuid;
begin
  select * into v_tx from public.maven_transactions where tx_id = p_tx;
  if v_tx.tx_id is null or v_tx.status is distinct from 'PAID' then return 'not_paid'; end if;

  v_key := right(regexp_replace(coalesce(v_tx.sender_number,''),'\D','','g'),10);
  if v_key = '' then return 'no_client_number'; end if;

  -- Only clients with more than one accepted transaction have verified history.
  select count(*) into v_paid
  from public.maven_transactions t
  where t.status = 'PAID'
    and right(regexp_replace(coalesce(t.sender_number,''),'\D','','g'),10) = v_key;
  if v_paid < 2 then return 'single_paid_transaction'; end if;

  select * into v_sms
  from public.inbound_sms s
  where s.consumed_by_tx_id = p_tx
    and s.amount = v_tx.amount
    and coalesce(s.sms_category,'') in ('deposit','received','income')
    and coalesce(s.sender_number,'') = ''
    and not coalesce(s.is_blocked,false)
    and not coalesce(s.is_duplicate,false)
  order by s.id
  limit 1;
  if v_sms.id is null then return 'no_phoneless_sms'; end if;

  v_name := btrim(regexp_replace(normalize(coalesce(v_sms.sender_name,''), NFKC), '\s+', ' ', 'g'));
  if length(v_name) < 4
     or length(v_name) > 60
     or v_name ~ '[\r\n]'
     or v_name ~* 'sms_sub_id|رصيد'
     or v_name ~ '\d{8}' then
    return 'name_not_safe';
  end if;

  -- A name already owned by another phone is ambiguous: record, never link.
  select exists (
    select 1
    from public.crm_clients c
    where right(regexp_replace(coalesce(c.normalized_phone,''),'\D','','g'),10) <> v_key
      and lower(btrim(v_name)) = any (
        select lower(btrim(n)) from unnest(coalesce(c.sms_names,'{}'::text[])) n
      )
  ) or exists (
    select 1
    from public.crm_client_names cn
    where right(regexp_replace(coalesce(cn.normalized_phone,''),'\D','','g'),10) <> v_key
      and lower(btrim(cn.name_variant)) = lower(v_name)
  ) or exists (
    select 1
    from public.crm_sms_name_links l
    where lower(l.name) = lower(v_name)
      and l.phone10 <> v_key
      and l.status = 'linked'
  ) into v_conflict;

  if v_conflict then
    insert into public.crm_sms_name_links(name, phone10, tx_id, sms_id, status, detail)
    values (v_name, v_key, p_tx, v_sms.id, 'conflict', 'name already belongs to another phone')
    on conflict do nothing;
    return 'conflict';
  end if;

  select c.id into v_client
  from public.crm_clients c
  where right(regexp_replace(coalesce(c.normalized_phone,''),'\D','','g'),10) = v_key
  order by c.updated_at desc nulls last
  limit 1;

  if v_client is null then
    insert into public.crm_sms_name_links(name, phone10, tx_id, sms_id, status, detail)
    values (v_name, v_key, p_tx, v_sms.id, 'skipped', 'no CRM client row for this phone')
    on conflict do nothing;
    return 'no_crm_client';
  end if;

  update public.crm_clients
  set sms_names = case
        when lower(v_name) = any (
          select lower(btrim(n)) from unnest(coalesce(sms_names,'{}'::text[])) n
        )
        then sms_names
        else array_append(coalesce(sms_names,'{}'::text[]), v_name)
      end,
      updated_at = now()
  where id = v_client;

  insert into public.crm_sms_name_links(name, phone10, tx_id, sms_id, status, detail)
  values (v_name, v_key, p_tx, v_sms.id, 'linked', 'learned from paid history (' || v_paid || ' paid transactions)')
  on conflict do nothing;

  return 'linked';
end
$f$;

revoke all on function public.learn_sms_name_for_tx(bigint) from public, anon, authenticated;

create or replace function public.trg_learn_sms_name_on_paid()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $f$
begin
  begin
    perform public.learn_sms_name_for_tx(new.tx_id);
  exception when others then
    null;
  end;
  return new;
end
$f$;

create or replace function public.trg_learn_sms_name_on_sms_link()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $f$
begin
  begin
    perform public.learn_sms_name_for_tx(new.consumed_by_tx_id);
  exception when others then
    null;
  end;
  return new;
end
$f$;

revoke all on function public.trg_learn_sms_name_on_paid() from public, anon, authenticated;
revoke all on function public.trg_learn_sms_name_on_sms_link() from public, anon, authenticated;

drop trigger if exists z_learn_sms_name on public.maven_transactions;
create trigger z_learn_sms_name
after update of status on public.maven_transactions
for each row
when (new.status = 'PAID' and old.status is distinct from 'PAID')
execute function public.trg_learn_sms_name_on_paid();

drop trigger if exists z_learn_sms_name_on_link on public.inbound_sms;
create trigger z_learn_sms_name_on_link
after update of consumed_by_tx_id on public.inbound_sms
for each row
when (new.consumed_by_tx_id is not null and old.consumed_by_tx_id is distinct from new.consumed_by_tx_id)
execute function public.trg_learn_sms_name_on_sms_link();

-- Optional backfill (run only after explicit owner approval):
-- select public.learn_sms_name_for_tx(tx_id)
-- from public.maven_transactions
-- where status = 'PAID'
--   and created_at > now() - interval '90 days';
--
-- Review the result:
-- select status, count(*) from public.crm_sms_name_links group by 1;
