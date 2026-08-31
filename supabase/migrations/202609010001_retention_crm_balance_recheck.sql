-- Retention deposits: re-evaluate trusted name-only SMS evidence when either
-- side arrives first. Matching remains conservative: exact amount, exact
-- receiving wallet, bounded time window, non-null balance, and either sender
-- phone or a CRM-trusted SMS name. Never use Maven's placeholder sender_name.

CREATE OR REPLACE FUNCTION public.evaluate_and_dispatch_ngpay_decision(p_tx_id bigint)
RETURNS text LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE v_tx public.maven_transactions; v_mm public.master_merchants; v_rule public.automation_rules_scoped;
  v_seen timestamptz; v_service_key text; v_request_id bigint; v_evidence int;
BEGIN
  SELECT * INTO v_tx FROM public.maven_transactions WHERE tx_id=p_tx_id;
  IF v_tx.tx_id IS NULL THEN RETURN 'not_found'; END IF;
  IF v_tx.status IS DISTINCT FROM 'PENDING' THEN RETURN 'not_pending'; END IF;
  IF v_tx.gateway IS DISTINCT FROM 'NagupayP2P' THEN RETURN 'unsupported_gateway'; END IF;
  v_seen := coalesce(v_tx.first_seen_at, nullif(v_tx.created_utc,'')::timestamptz);
  IF v_seen IS NULL THEN RETURN 'no_timestamp'; END IF;
  v_mm := public.resolve_master_merchant(p_tx_id);
  IF NOT public.is_source_enabled(v_mm.id) THEN RETURN 'source_disabled'; END IF;

  SELECT * INTO v_rule FROM public.automation_rules_scoped r
   WHERE r.enabled AND (r.master_merchant IS NULL OR lower(r.master_merchant) IN (lower(v_mm.code),lower(v_mm.name)))
     AND (r.merchant IS NULL OR r.merchant=v_tx.merchant) AND (r.sub_merchant IS NULL OR r.sub_merchant=v_tx.sub_merchant)
     AND (r.payment_method IS NULL OR r.payment_method=v_tx.payment_method) AND (r.provider IS NULL OR r.provider=v_mm.provider)
     AND v_tx.amount BETWEEN r.min_amount AND r.max_amount
   ORDER BY r.priority DESC LIMIT 1;
  IF v_rule.id IS NULL THEN RETURN 'no_rule_match'; END IF;

  IF v_rule.action_type='approve' THEN
    SELECT count(*) INTO v_evidence FROM public.inbound_sms s
     WHERE s.amount=v_tx.amount
       AND (s.consumed_by_tx_id IS NULL OR s.consumed_by_tx_id=v_tx.tx_id)
       AND s.received_at BETWEEN v_seen-interval '15 min' AND v_seen+interval '90 min'
       AND regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g')
           = regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g')
       AND s.balance_after IS NOT NULL AND coalesce(s.sms_category,'') IN ('deposit','received','income')
       AND ((nullif(s.sender_number,'') IS NOT NULL AND regexp_replace(s.sender_number,'\D','','g')=regexp_replace(coalesce(v_tx.sender_number,''),'\D','','g'))
         OR EXISTS (SELECT 1 FROM public.crm_clients c WHERE regexp_replace(coalesce(c.normalized_phone,''),'\D','','g')=regexp_replace(coalesce(v_tx.sender_number,''),'\D','','g')
           AND EXISTS (SELECT 1 FROM unnest(coalesce(c.sms_names,'{}'::text[])) n WHERE lower(trim(n))=lower(trim(s.sender_name))));
    IF v_evidence=0 THEN RETURN 'approve_blocked_no_payment_evidence'; END IF;
  ELSIF v_rule.action_type='decline' THEN
    IF extract(epoch FROM (now()-v_seen))/60.0 < greatest(coalesce(v_rule.time_window_minutes,5),5) THEN RETURN 'waiting_grace_period'; END IF;
  ELSE RETURN 'unknown_action_type'; END IF;

  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name='daily_report_service_key';
  IF v_service_key IS NULL THEN RETURN 'dispatch_key_missing'; END IF;
  SELECT net.http_post(url:='https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),
    body:=jsonb_build_object('tx_id',p_tx_id,'decision',case v_rule.action_type when 'approve' then 'PAID' else 'DECLINED' end,
      'actor_name','automation-engine','remark','rule:'||v_rule.id::text||' scope:'||v_rule.scope_type)) INTO v_request_id;
  RETURN 'dispatched_'||v_rule.action_type||'_request_'||v_request_id::text;
END; $function$;

INSERT INTO public.automation_rules_scoped
  (scope_type,master_merchant,min_amount,max_amount,time_window_minutes,action_type,priority,use_crm_matching,use_near_amount,use_unique_amount,enabled)
SELECT 'global','ngpay',1,5000,90,'approve',12,true,false,false,true
WHERE NOT EXISTS (SELECT 1 FROM public.automation_rules_scoped WHERE scope_type='global' AND lower(coalesce(master_merchant,''))='ngpay' AND action_type='approve' AND priority=12);

CREATE OR REPLACE FUNCTION public.trg_recheck_pending_on_new_transaction() RETURNS trigger LANGUAGE plpgsql SET search_path TO public AS $function$
BEGIN IF new.status='PENDING' AND new.gateway='NagupayP2P' THEN BEGIN PERFORM public.evaluate_and_dispatch_ngpay_decision(new.tx_id); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'retention transaction recheck failed: %',sqlerrm; END; END IF; RETURN new; END; $function$;
CREATE OR REPLACE FUNCTION public.trg_recheck_pending_on_new_sms() RETURNS trigger LANGUAGE plpgsql SET search_path TO public AS $function$
DECLARE tx record;
BEGIN IF coalesce(new.sms_category,'') IN ('deposit','received','income') AND new.amount IS NOT NULL AND coalesce(new.confirmed_wallet_number,new.wallet_number,new.receiver_number) IS NOT NULL THEN
  FOR tx IN SELECT mt.tx_id FROM public.maven_transactions mt WHERE mt.status='PENDING' AND mt.gateway='NagupayP2P' AND mt.amount=new.amount
    AND regexp_replace(coalesce(mt.receiving_wallet,mt.to_account_number,''),'\D','','g')=regexp_replace(coalesce(new.confirmed_wallet_number,new.wallet_number,new.receiver_number,''),'\D','','g')
    AND coalesce(mt.first_seen_at,nullif(mt.created_utc,'')::timestamptz) BETWEEN new.received_at-interval '15 min' AND new.received_at+interval '90 min'
  LOOP BEGIN PERFORM public.evaluate_and_dispatch_ngpay_decision(tx.tx_id); EXCEPTION WHEN OTHERS THEN RAISE WARNING 'retention SMS recheck failed for tx %: %',tx.tx_id,sqlerrm; END; END LOOP;
END IF; RETURN new; END; $function$;

DROP TRIGGER IF EXISTS trg_recheck_pending_transaction ON public.maven_transactions;
CREATE TRIGGER trg_recheck_pending_transaction AFTER INSERT ON public.maven_transactions FOR EACH ROW EXECUTE FUNCTION public.trg_recheck_pending_on_new_transaction();
DROP TRIGGER IF EXISTS trg_recheck_pending_sms ON public.inbound_sms;
CREATE TRIGGER trg_recheck_pending_sms AFTER INSERT ON public.inbound_sms FOR EACH ROW EXECUTE FUNCTION public.trg_recheck_pending_on_new_sms();
