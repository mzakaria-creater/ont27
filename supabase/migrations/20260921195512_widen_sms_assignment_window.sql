-- SMS delivery can lag the provider transaction by several minutes. Keep the
-- same-day, sender/CRM and uniqueness guards, but allow up to ten minutes for
-- the reciprocal assignment instead of the old two-minute window.
DO $migration$
DECLARE
  v_definition text;
BEGIN
  select pg_get_functiondef('public.assign_unique_sms_to_maven_tx(bigint,integer)'::regprocedure)
    into v_definition;
  if v_definition is not null and position('DEFAULT 120' in v_definition) > 0 then
    v_definition := replace(v_definition, 'p_max_seconds integer DEFAULT 120', 'p_max_seconds integer DEFAULT 600');
    execute v_definition;
  end if;

  select pg_get_functiondef('public.evaluate_and_dispatch_ngpay_decision(bigint)'::regprocedure)
    into v_definition;
  if v_definition is not null and position('assign_unique_sms_to_maven_tx(p_tx_id,120)' in v_definition) > 0 then
    v_definition := replace(v_definition, 'assign_unique_sms_to_maven_tx(p_tx_id,120)', 'assign_unique_sms_to_maven_tx(p_tx_id,600)');
    execute v_definition;
  end if;
END;
$migration$;
