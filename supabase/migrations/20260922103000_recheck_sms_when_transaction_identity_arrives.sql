-- Maven may insert a transaction before sender_number or wallet fields are
-- populated. Re-run the safe evaluator when those identity fields arrive so
-- the first SMS/transaction match is not lost during the initial insert race.
CREATE OR REPLACE FUNCTION public.trg_recheck_pending_transaction_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if new.status = 'PENDING' and new.gateway = 'NagupayP2P' then
    begin
      perform public.evaluate_and_dispatch_ngpay_decision(new.tx_id);
    exception when others then
      raise warning 'transaction identity recheck failed for %: %', new.tx_id, sqlerrm;
    end;
  end if;
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS trg_recheck_pending_transaction_identity ON public.maven_transactions;
CREATE TRIGGER trg_recheck_pending_transaction_identity
AFTER UPDATE OF sender_number, amount, receiving_wallet, to_account_number, first_seen_at
ON public.maven_transactions
FOR EACH ROW
WHEN (new.status = 'PENDING')
EXECUTE FUNCTION public.trg_recheck_pending_transaction_identity();
