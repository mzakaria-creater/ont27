-- A unique, verified SMS assignment overrides a sender blacklist. Duplicate
-- evidence remains manual review and is never auto-approved.
CREATE OR REPLACE FUNCTION public.enqueue_decision(
  p_tx_id bigint, p_action text, p_actor_type text, p_actor_id text,
  p_actor_name text DEFAULT NULL, p_amount_override numeric DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE
  v_mm public.master_merchants;
  v_tx public.maven_transactions;
  v_job uuid;
  v_override boolean := false;
  v_duplicate boolean := false;
  v_seen timestamptz;
BEGIN
  IF p_action NOT IN ('approve','decline') THEN RAISE EXCEPTION 'INVALID_ACTION: %', p_action USING ERRCODE = 'P0001'; END IF;
  IF p_actor_type NOT IN ('manual_panel','auto_trigger') THEN RAISE EXCEPTION 'INVALID_ACTOR_TYPE: %', p_actor_type USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_tx FROM public.maven_transactions WHERE tx_id = p_tx_id FOR UPDATE;
  IF v_tx.tx_id IS NULL THEN RAISE EXCEPTION 'TX_NOT_FOUND: %', p_tx_id USING ERRCODE = 'P0001'; END IF;
  v_mm := public.resolve_master_merchant(p_tx_id);
  IF p_actor_type = 'auto_trigger' AND NOT public.is_source_enabled(v_mm.id) THEN RAISE EXCEPTION 'SOURCE_DISABLED: automation off for master merchant %', v_mm.code USING ERRCODE = 'P0001'; END IF;
  v_seen := coalesce(v_tx.first_seen_at, nullif(v_tx.created_utc,'')::timestamptz);
  IF p_action = 'decline' AND EXISTS (
    SELECT 1 FROM public.inbound_sms s
    WHERE s.consumed_by_tx_id = p_tx_id AND coalesce(s.is_blocked,false) = false AND coalesce(s.is_duplicate,false) = false
      AND coalesce(s.sms_category,'') IN ('deposit','received','income') AND s.amount = v_tx.amount
      AND regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g') = regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g')
  ) THEN
    IF v_seen IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.maven_transactions sibling
      WHERE sibling.tx_id <> p_tx_id AND sibling.status IN ('PAID','APPROVED') AND sibling.amount = v_tx.amount
        AND nullif(regexp_replace(coalesce(sibling.sender_number,''),'\D','','g'),'') = nullif(regexp_replace(coalesce(v_tx.sender_number,''),'\D','','g'),'')
        AND sibling.first_seen_at BETWEEN v_seen - interval '30 minutes' AND v_seen + interval '30 minutes'
    ) THEN RAISE EXCEPTION 'DUPLICATE_SMS_EVIDENCE: manual review required' USING ERRCODE = 'P0001'; END IF;
    p_action := 'approve'; v_override := true;
  END IF;
  INSERT INTO public.browser_jobs (tx_id,guid,amount,target_status,provider,source,mission,metadata)
  VALUES (p_tx_id,v_tx.guid,coalesce(p_amount_override,v_tx.amount),case p_action when 'approve' then 'PAID' else 'DECLINED' end,v_mm.provider,v_mm.code,p_action,jsonb_build_object('actor_type',p_actor_type,'actor_id',p_actor_id,'blacklist_override',v_override,'duplicate_evidence',v_duplicate))
  RETURNING id INTO v_job;
  INSERT INTO public.audit_log (actor_type,actor_id,actor_name,action,entity,entity_id,master_merchant_id,after)
  VALUES (p_actor_type,p_actor_id,p_actor_name,case when v_override then 'deposit.approve_blacklist_override' else 'deposit.'||p_action end,'maven_transactions',p_tx_id::text,v_mm.id,jsonb_build_object('job_id',v_job,'amount',coalesce(p_amount_override,v_tx.amount),'provider',v_mm.provider,'blacklist_override',v_override,'duplicate_flag',v_duplicate));
  RETURN v_job;
END;
$function$;
