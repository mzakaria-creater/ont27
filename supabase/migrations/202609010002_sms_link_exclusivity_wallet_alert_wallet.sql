-- Enforce one evidence SMS per transaction. The SMS primary key already makes
-- one SMS belong to one mapping row; this trigger closes the other direction.
create or replace function public.prevent_duplicate_sms_maven_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.sms_maven_matches m
    where m.tx_id = new.tx_id
      and m.sms_id <> new.sms_id
  ) then
    raise exception using
      errcode = '23505',
      message = 'transaction_already_linked_to_sms';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sms_maven_one_sms_per_tx on public.sms_maven_matches;
create trigger trg_sms_maven_one_sms_per_tx
before insert or update of tx_id, sms_id on public.sms_maven_matches
for each row execute function public.prevent_duplicate_sms_maven_link();

-- Protect the live matcher as well as the mapping table. Assignment is only
-- allowed from an unlinked SMS; relinking to a different transaction is
-- rejected, while an explicit unlink (setting the value to NULL) remains
-- available to authorised operators.
create or replace function public.prevent_sms_reassignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.consumed_by_tx_id is not null
     and new.consumed_by_tx_id is not null
     and new.consumed_by_tx_id <> old.consumed_by_tx_id then
    raise exception using errcode = '23505', message = 'sms_already_linked_to_transaction';
  end if;
  if new.consumed_by_tx_id is not null
     and exists (
       select 1 from public.inbound_sms s
       where s.id <> new.id and s.consumed_by_tx_id = new.consumed_by_tx_id
     ) then
    raise exception using errcode = '23505', message = 'transaction_already_linked_to_sms';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inbound_sms_link_exclusivity on public.inbound_sms;
create trigger trg_inbound_sms_link_exclusivity
before update of consumed_by_tx_id on public.inbound_sms
for each row execute function public.prevent_sms_reassignment();

-- Balance alerts must use the wallet reported by the SMS. Some device rows
-- carry a stale wallet_number while confirmed_wallet_number/receiver_number
-- is the actual receiving SIM. Keep this precedence consistent everywhere.
create or replace function public.wallet_balance_alert_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg public.wallet_balance_alert_config;
  v_result jsonb;
begin
  select * into v_cfg from public.wallet_balance_alert_config where id = true;
  if v_cfg is null or not v_cfg.enabled then
    return jsonb_build_object('enabled', false, 'wallets', '[]'::jsonb);
  end if;

  with normalized as (
    select s.*,
           coalesce(nullif(trim(s.confirmed_wallet_number), ''),
                    nullif(trim(s.receiver_number), ''),
                    nullif(trim(s.wallet_number), '')) as wallet,
           coalesce(s.received_at, s.created_at) as reading_at
      from public.inbound_sms s
  ), latest as (
    select distinct on (n.wallet)
           n.wallet, n.balance_after, n.reading_at
      from normalized n
     where n.wallet is not null
       and n.balance_after is not null
       and n.reading_at >= now() - make_interval(hours => v_cfg.lookback_hours)
     order by n.wallet, n.reading_at desc, n.id desc
  ), seeded as (
    insert into public.wallet_balance_alert_state (wallet_number, last_balance, last_sms_at)
    select l.wallet, l.balance_after, l.reading_at from latest l
    on conflict (wallet_number) do nothing
    returning wallet_number
  ), due as (
    select l.wallet, l.balance_after as balance, l.reading_at as balance_at,
           st.last_balance, st.last_sms_at,
           l.balance_after - st.last_balance as delta
      from latest l
      join public.wallet_balance_alert_state st on st.wallet_number = l.wallet
     where l.wallet not in (select wallet_number from seeded)
       and st.last_balance is not null
       and st.last_sms_at is not null
       and l.reading_at > st.last_sms_at
       and abs(l.balance_after - st.last_balance) >= v_cfg.min_delta
       and (st.last_alert_at is null
            or st.last_alert_at <= now() - make_interval(mins => v_cfg.cooldown_minutes))
  ), window_totals as (
    select d.wallet,
           coalesce(sum(n.amount) filter (where n.sms_category = 'deposit'), 0) as received,
           coalesce(sum(n.amount) filter (where n.sms_category = 'withdrawal'), 0) as sent,
           count(*) filter (where n.sms_category = 'deposit') as deposits,
           count(*) filter (where n.sms_category = 'withdrawal') as withdrawals
      from due d
      left join normalized n
        on n.wallet = d.wallet
       and n.reading_at > d.last_sms_at
       and n.reading_at <= d.balance_at
     group by d.wallet
  ), claimed as (
    update public.wallet_balance_alert_state st
       set last_balance = d.balance,
           last_sms_at = d.balance_at,
           last_alert_at = now(),
           alerts_sent = st.alerts_sent + 1
      from due d
     where st.wallet_number = d.wallet
    returning st.wallet_number
  )
  select jsonb_build_object(
    'enabled', true,
    'minDelta', v_cfg.min_delta,
    'cooldownMinutes', v_cfg.cooldown_minutes,
    'generatedAt', now(),
    'wallets', coalesce(jsonb_agg(jsonb_build_object(
      'wallet', d.wallet,
      'device', m.device,
      'provider', m.provider,
      'balance', round(d.balance, 2),
      'balanceAt', d.balance_at,
      'previousBalance', round(d.last_balance, 2),
      'delta', round(d.delta, 2),
      'received', round(w.received, 2),
      'sent', round(w.sent, 2),
      'net', round(w.received - w.sent, 2),
      'deposits', w.deposits,
      'withdrawals', w.withdrawals,
      'unexplained', round(d.delta - (w.received - w.sent), 2),
      'since', d.last_sms_at
    ) order by abs(d.delta) desc), '[]'::jsonb)
  ) into v_result
  from due d
  join window_totals w on w.wallet = d.wallet
  left join public.wallet_device_map m
    on right(regexp_replace(m.to_account_number, '\D', '', 'g'), 10)
     = right(regexp_replace(d.wallet, '\D', '', 'g'), 10)
  where exists (select 1 from claimed c where c.wallet_number = d.wallet);

  return coalesce(v_result, jsonb_build_object(
    'enabled', true, 'minDelta', v_cfg.min_delta,
    'cooldownMinutes', v_cfg.cooldown_minutes,
    'generatedAt', now(), 'wallets', '[]'::jsonb));
end;
$$;
