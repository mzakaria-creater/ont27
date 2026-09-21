-- Prevent automatic SMS evidence from crossing Cairo calendar days or from
-- using wallet+timing alone when both sender numbers are available.
CREATE OR REPLACE FUNCTION public.assign_unique_sms_to_maven_tx(p_tx_id bigint, p_max_seconds integer DEFAULT 120)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tx public.maven_transactions%rowtype;
  v_sms_id bigint;
  v_candidate_count integer;
  v_tx_time timestamptz;
begin
  perform pg_advisory_xact_lock(p_tx_id);

  select * into v_tx
  from public.maven_transactions
  where tx_id = p_tx_id
  for update;

  if v_tx.tx_id is null
     or v_tx.status is distinct from 'PENDING'
     or v_tx.gateway is distinct from 'NagupayP2P'
     or v_tx.amount is null then
    return null;
  end if;

  v_tx_time := coalesce(v_tx.first_seen_at, public.parse_maven_utc(v_tx.created_utc));
  if v_tx_time is null then return null; end if;

  select s.id into v_sms_id
  from public.inbound_sms s
  where s.amount = v_tx.amount
    and coalesce(s.sms_category,'') in ('deposit','received','income')
    and not coalesce(s.is_blocked,false)
    and not coalesce(s.is_duplicate,false)
    and s.balance_after is not null
    and s.consumed_by_tx_id is null
    and not exists (select 1 from public.sms_maven_matches mm where mm.sms_id=s.id)
    and (
      (nullif(s.sender_number,'') is not null
       and nullif(v_tx.sender_number,'') is not null
       and regexp_replace(s.sender_number,'\D','','g') = regexp_replace(v_tx.sender_number,'\D','','g'))
      or (nullif(s.sender_number,'') is null
          and nullif(v_tx.sender_number,'') is not null
          and exists (
            select 1 from public.crm_clients c
            where regexp_replace(coalesce(c.normalized_phone,c.phone_no,''),'\D','','g') = regexp_replace(v_tx.sender_number,'\D','','g')
              and (lower(trim(s.sender_name)) = lower(trim(c.client_name))
                   or exists (select 1 from unnest(coalesce(c.sms_names,'{}'::text[])) n where lower(trim(n)) = lower(trim(s.sender_name))))
          ))
    )
    and (s.received_at at time zone 'Africa/Cairo')::date = (v_tx_time at time zone 'Africa/Cairo')::date
    and abs(extract(epoch from (s.received_at - v_tx_time))) <= greatest(p_max_seconds,30)
    and not exists (
      select 1
      from public.maven_transactions other
      where other.tx_id <> v_tx.tx_id
        and other.status='PENDING'
        and other.gateway='NagupayP2P'
        and other.amount=v_tx.amount
        and nullif(other.sender_number,'') is not null
        and (
          (nullif(s.sender_number,'') is not null and regexp_replace(other.sender_number,'\D','','g') = regexp_replace(s.sender_number,'\D','','g'))
          or (nullif(s.sender_number,'') is null and nullif(v_tx.sender_number,'') is not null
              and regexp_replace(other.sender_number,'\D','','g') = regexp_replace(v_tx.sender_number,'\D','','g'))
        )
        and abs(extract(epoch from (s.received_at - coalesce(other.first_seen_at, public.parse_maven_utc(other.created_utc))))) < abs(extract(epoch from (s.received_at - v_tx_time)))
    )
  order by
    case when right(regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g'),10)
              = right(regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g'),10)
         then 0 else 1 end,
    abs(extract(epoch from (s.received_at - v_tx_time))),
    s.id
  limit 1;

  if v_sms_id is null then return null; end if;

  select count(*) into v_candidate_count
  from public.inbound_sms s
  where s.amount=v_tx.amount
    and coalesce(s.sms_category,'') in ('deposit','received','income')
    and not coalesce(s.is_blocked,false)
    and not coalesce(s.is_duplicate,false)
    and s.balance_after is not null
    and s.consumed_by_tx_id is null
    and not exists (select 1 from public.sms_maven_matches mm where mm.sms_id=s.id)
    and (
      (nullif(s.sender_number,'') is not null
       and nullif(v_tx.sender_number,'') is not null
       and regexp_replace(s.sender_number,'\D','','g') = regexp_replace(v_tx.sender_number,'\D','','g'))
      or (nullif(s.sender_number,'') is null
          and nullif(v_tx.sender_number,'') is not null
          and exists (
            select 1 from public.crm_clients c
            where regexp_replace(coalesce(c.normalized_phone,c.phone_no,''),'\D','','g') = regexp_replace(v_tx.sender_number,'\D','','g')
              and (lower(trim(s.sender_name)) = lower(trim(c.client_name))
                   or exists (select 1 from unnest(coalesce(c.sms_names,'{}'::text[])) n where lower(trim(n)) = lower(trim(s.sender_name))))
          ))
    )
    and (s.received_at at time zone 'Africa/Cairo')::date = (v_tx_time at time zone 'Africa/Cairo')::date
    and abs(extract(epoch from (s.received_at - v_tx_time))) <= greatest(p_max_seconds,30)
    and abs(extract(epoch from (s.received_at - v_tx_time))) <= (
      select abs(extract(epoch from (chosen.received_at - v_tx_time))) + 10
      from public.inbound_sms chosen where chosen.id=v_sms_id
    );

  if v_candidate_count <> 1 then return null; end if;

  update public.inbound_sms
  set consumed_by_tx_id=v_tx.tx_id,
      matched_transaction_id=v_tx.tx_id,
      matched=true,
      match_status='auto_matched_reciprocal_time',
      auto_match_score=95,
      review_required=false,
      processed_at=coalesce(processed_at,now()),
      notes=concat_ws('; ',nullif(notes,''),'assigned_by_reciprocal_amount_time_same_day_sender')
  where id=v_sms_id and consumed_by_tx_id is null;

  if not found then return null; end if;

  insert into public.sms_maven_matches
    (sms_id,tx_id,receiving_wallet,sms_amount,mv_amount,received_at,mv_time,sec_diff,webhook_name,matched_at)
  select s.id,v_tx.tx_id,
         coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number),
         s.amount,v_tx.amount,s.received_at,v_tx_time,
         abs(extract(epoch from (s.received_at-v_tx_time))),
         s.webhook_name,now()
  from public.inbound_sms s where s.id=v_sms_id
  on conflict (sms_id) do nothing;

  return v_sms_id;
end;
$function$;
