-- Keep manually blocked SMS out of all automatic payment evidence checks.
create or replace function public.evaluate_and_dispatch_ngpay_decision(p_tx_id bigint)
returns text language plpgsql set search_path = public as $$
declare
  v_tx public.maven_transactions; v_mm public.master_merchants; v_rule public.automation_rules_scoped;
  v_seen timestamptz; v_pending_minutes numeric; v_service_key text; v_request_id bigint; v_evidence int;
begin
  select * into v_tx from public.maven_transactions where tx_id=p_tx_id;
  if v_tx.tx_id is null then return 'not_found'; end if;
  if v_tx.status is distinct from 'PENDING' then return 'not_pending'; end if;
  if v_tx.gateway is distinct from 'NagupayP2P' then return 'unsupported_gateway'; end if;
  v_seen := coalesce(v_tx.first_seen_at, nullif(v_tx.created_utc,'')::timestamptz);
  if v_seen is null then return 'no_timestamp'; end if;
  v_mm := public.resolve_master_merchant(p_tx_id);
  if not public.is_source_enabled(v_mm.id) then return 'source_disabled'; end if;
  select * into v_rule from public.automation_rules_scoped r
   where r.enabled and (r.master_merchant is null or lower(r.master_merchant) in (lower(v_mm.code),lower(v_mm.name)))
     and (r.merchant is null or r.merchant=v_tx.merchant) and (r.sub_merchant is null or r.sub_merchant=v_tx.sub_merchant)
     and (r.payment_method is null or r.payment_method=v_tx.payment_method) and (r.provider is null or r.provider=v_mm.provider)
     and v_tx.amount between r.min_amount and r.max_amount order by r.priority desc limit 1;
  if v_rule.id is null then return 'no_rule_match'; end if;
  if v_rule.action_type='approve' then
    select count(*) into v_evidence from public.inbound_sms s
     where not coalesce(s.is_blocked,false) and s.amount=v_tx.amount
       and s.received_at between v_seen-interval '15 min' and v_seen+interval '90 min'
       and regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g')=regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g')
       and s.balance_after is not null and coalesce(s.sms_category,'') in ('deposit','received','income')
       and ((nullif(s.sender_number,'') is not null and regexp_replace(s.sender_number,'\D','','g')=regexp_replace(coalesce(v_tx.sender_number,''),'\D','','g'))
         or exists (select 1 from public.crm_clients c where regexp_replace(coalesce(c.normalized_phone,''),'\D','','g')=regexp_replace(coalesce(v_tx.sender_number,''),'\D','','g')
           and exists (select 1 from unnest(coalesce(c.sms_names,'{}'::text[])) n where lower(trim(n))=lower(trim(s.sender_name)))));
    if v_evidence=0 then return 'approve_blocked_no_payment_evidence'; end if;
  elsif v_rule.action_type='decline' then
    v_pending_minutes:=extract(epoch from(now()-v_seen))/60.0;
    if v_pending_minutes < greatest(coalesce(v_rule.time_window_minutes,5),5) then return 'waiting_grace_period'; end if;
  else return 'unknown_action_type'; end if;
  select decrypted_secret into v_service_key from vault.decrypted_secrets where name='daily_report_service_key';
  if v_service_key is null then return 'dispatch_key_missing'; end if;
  select net.http_post(url:='https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),body:=jsonb_build_object('tx_id',p_tx_id,'decision',case v_rule.action_type when 'approve' then 'PAID' else 'DECLINED' end,'actor_name','automation-engine','remark','rule:'||v_rule.id::text||' scope:'||v_rule.scope_type)) into v_request_id;
  return 'dispatched_'||v_rule.action_type||'_request_'||v_request_id::text;
end;
$$;
