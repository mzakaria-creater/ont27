-- Auto-decline every pending NGPay transaction whose sender phone is blocked.
-- This is intentionally amount-independent; phone is the only blacklist identity.
-- The check is inserted into the live core evaluator so cron and transaction/SMS
-- rechecks use the same rule. SMS evidence is not required for a blacklist decline.
DO $migration$
DECLARE
  v_definition text;
  v_marker text := $$  select * into v_settings from public.automation_settings where id = 1;$$;
  v_insert text := $body$
  -- blacklisted_sender_any_amount: a blocked phone is never eligible for payment, regardless of amount or
  -- configured amount rules. Keep the comparison digit-normalized so values
  -- such as +20 10... and 010... resolve to the same identity.
  if nullif(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), '') is not null
     and exists (
       select 1
       from public.api_risk_blacklist b
       where lower(coalesce(b.type, '')) = 'phone'
         and nullif(regexp_replace(coalesce(b.value, ''), '\D', '', 'g'), '')
             = regexp_replace(v_tx.sender_number, '\D', '', 'g')
     ) then
    select decrypted_secret into v_service_key
      from vault.decrypted_secrets where name = 'daily_report_service_key';
    if v_service_key is null then return 'blacklisted_phone_key_missing'; end if;
    select net.http_post(
      url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),
      body := jsonb_build_object(
        'tx_id', p_tx_id,
        'decision', 'DECLINED',
        'actor_name', 'automation-engine-blacklist',
        'remark', 'Auto-decline: sender phone is blacklisted (amount-independent)'
      )
    ) into v_request_id;
    return 'dispatched_decline_blacklisted_phone_request_' || v_request_id::text;
  end if;
$body$;
BEGIN
  SELECT pg_get_functiondef('public.evaluate_and_dispatch_ngpay_decision_core(bigint)'::regprocedure)
    INTO v_definition;
  -- This migration is safe to replay. Some production revisions already
  -- contain the equivalent blacklist guard (using a right-most 10-digit
  -- comparison), so do not duplicate it.
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'evaluate_and_dispatch_ngpay_decision_core not found';
  ELSIF position('blacklisted_sender_any_amount' IN v_definition) > 0 THEN
    RETURN;
  ELSIF position(v_marker IN v_definition) = 0 THEN
    RAISE EXCEPTION 'evaluate_and_dispatch_ngpay_decision_core marker not found';
  END IF;
  v_definition := replace(v_definition, v_marker, v_marker || E'\n' || v_insert);
  EXECUTE v_definition;
END;
$migration$;
