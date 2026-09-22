-- Allow a first-deposit SMS with no sender/wallet metadata to auto-link only
-- when it has one unambiguous same-amount transaction within three minutes.
-- Any competing pending transaction in that window keeps the SMS on HOLD.
DO $migration$
DECLARE
  v_definition text;
  v_marker text := 'first_deposit_unique_time_fallback';
  v_old text := $old$    )
    and (s.received_at at time zone 'Africa/Cairo')::date$old$;
  v_new text := $new$      or ( /* first_deposit_unique_time_fallback */
          nullif(s.sender_number,'') is null
          and nullif(v_tx.sender_number,'') is not null
          and abs(extract(epoch from (s.received_at - v_tx_time))) <= 180
          and (
            nullif(regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g'),'') is null
            or nullif(regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g'),'') is null
            or right(regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g'),10)
               = right(regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g'),10)
          )
          and not exists (
            select 1 from public.maven_transactions other
            where other.tx_id <> v_tx.tx_id
              and other.status='PENDING'
              and other.gateway='NagupayP2P'
              and other.amount=v_tx.amount
              and abs(extract(epoch from (s.received_at - coalesce(other.first_seen_at, public.parse_maven_utc(other.created_utc))))) <= 180
          )
        )
    )
    and (s.received_at at time zone 'Africa/Cairo')::date$new$;
BEGIN
  select pg_get_functiondef('public.assign_unique_sms_to_maven_tx(bigint,integer)'::regprocedure)
    into v_definition;
  if v_definition is null then raise exception 'assign_unique_sms_to_maven_tx not found'; end if;
  if position(v_marker in v_definition) > 0 then return; end if;
  if position(v_old in v_definition) = 0 then raise exception 'candidate boundary not found'; end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
END;
$migration$;
