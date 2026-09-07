create or replace function public.trg_recheck_pending_on_sms_update()
returns trigger
language plpgsql
set search_path = public
as $function$
declare tx record;
begin
  if coalesce(new.sms_category,'') in ('deposit','received','income')
     and new.amount is not null
     and coalesce(new.confirmed_wallet_number, new.wallet_number, new.receiver_number) is not null
     and (new.amount is distinct from old.amount or new.received_at is distinct from old.received_at
       or new.receiver_number is distinct from old.receiver_number or new.wallet_number is distinct from old.wallet_number
       or new.confirmed_wallet_number is distinct from old.confirmed_wallet_number or new.sms_category is distinct from old.sms_category) then
    for tx in select mt.tx_id from public.maven_transactions mt
      where mt.status = 'PENDING' and mt.gateway = 'NagupayP2P' and mt.amount = new.amount
        and regexp_replace(coalesce(mt.receiving_wallet, mt.to_account_number, ''), '\\D', '', 'g') = regexp_replace(coalesce(new.confirmed_wallet_number, new.wallet_number, new.receiver_number, ''), '\\D', '', 'g')
        and coalesce(mt.first_seen_at, nullif(mt.created_utc,'')::timestamptz) between new.received_at - interval '15 min' and new.received_at + interval '90 min'
    loop
      begin perform public.evaluate_and_dispatch_ngpay_decision(tx.tx_id);
      exception when others then raise warning 'SMS update recheck failed for tx %: %', tx.tx_id, sqlerrm; end;
    end loop;
  end if;
  return new;
end;
$function$;
drop trigger if exists trg_recheck_pending_on_sms_update on public.inbound_sms;
create trigger trg_recheck_pending_on_sms_update
after update of amount, received_at, receiver_number, wallet_number, confirmed_wallet_number, sms_category
on public.inbound_sms for each row execute function public.trg_recheck_pending_on_sms_update();
