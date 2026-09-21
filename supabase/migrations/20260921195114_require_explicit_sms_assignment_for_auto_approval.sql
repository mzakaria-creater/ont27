-- Automatic approval requires an explicit SMS-to-transaction assignment.
-- A same-amount/wallet/time candidate is not sufficient evidence: it must be
-- recorded on the transaction itself before the provider can be marked PAID.
DO $migration$
DECLARE
  v_definition text;
  v_marker text := $$    if v_evidence > 0 then$$;
  v_insert text := $body$
    if v_evidence > 0 then
      -- Never approve from a merely matching/unassigned SMS. The assignment
      -- can be created by the reciprocal matcher or by an operator, but the
      -- provider decision must see the persisted link first.
      if not exists (
        select 1
        from public.inbound_sms assigned_sms
        where assigned_sms.consumed_by_tx_id = v_tx.tx_id
           or assigned_sms.matched_transaction_id = v_tx.tx_id
           or assigned_sms.maven_transaction_id = v_tx.tx_id::text
      ) then
        return 'approve_blocked_sms_not_assigned';
      end if;
$body$;
  v_functions text[] := array[
    'public.evaluate_and_dispatch_ngpay_decision_core(bigint)',
    'public.evaluate_and_dispatch_ngpay_decision(bigint)'
  ];
  v_signature text;
BEGIN
  foreach v_signature in array v_functions loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    if v_definition is null then
      continue;
    end if;
    -- Idempotent: do not add a second guard if this migration is replayed.
    if position('approve_blocked_sms_not_assigned' in v_definition) > 0 then
      continue;
    end if;
    if position(v_marker in v_definition) = 0 then
      continue;
    end if;
    v_definition := replace(v_definition, v_marker, v_insert);
    execute v_definition;
  end loop;
END;
$migration$;
