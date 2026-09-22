-- Re-run the safe transaction evaluator for deposit SMS even when the
-- provider omits wallet/receiver metadata. The evaluator still requires the
-- amount, same-day/time window, balance, and sender identity rules before it
-- can link or execute anything.
DO $migration$
DECLARE
  v_name text;
  v_definition text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['trg_recheck_pending_on_new_sms','trg_recheck_pending_on_sms_update'] LOOP
    select pg_get_functiondef(p.oid)
      into v_definition
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_name
    limit 1;
    if v_definition is null then
      raise exception '% not found', v_name;
    end if;

    v_definition := replace(v_definition,
      'and coalesce(new.confirmed_wallet_number, new.wallet_number, new.receiver_number) is not null',
      'and new.amount is not null');
    v_definition := replace(v_definition,
      $old$and regexp_replace(coalesce(mt.receiving_wallet, mt.to_account_number, ''), '\\D', '', 'g')
             = regexp_replace(coalesce(new.confirmed_wallet_number, new.wallet_number, new.receiver_number, ''), '\\D', '', 'g')$old$,
      $new$and (
          nullif(regexp_replace(coalesce(new.confirmed_wallet_number, new.wallet_number, new.receiver_number, ''), '\\D', '', 'g'), '') is null
          or regexp_replace(coalesce(mt.receiving_wallet, mt.to_account_number, ''), '\\D', '', 'g')
             = regexp_replace(coalesce(new.confirmed_wallet_number, new.wallet_number, new.receiver_number, ''), '\\D', '', 'g')
        )$new$);
    execute v_definition;
  END LOOP;
END;
$migration$;
