-- SMS matching recovery hotfix (V2)
-- Fixes schema drift in source checks and makes the paid-SMS recovery sweep
-- idempotent. Apply to project iwhjmhazcvctvipoasct.

create or replace function public.is_source_enabled(p_master_merchant_id uuid)
returns boolean language sql stable set search_path=public as $$
  select coalesce((select s.automation_enabled from public.automation_settings s where s.id=1),false)
     and coalesce((select case lower(m.slug)
       when 'ngpay' then s.ngpay_enabled
       when 'payfuture' then s.payfuture_enabled
       else false end
       from public.master_merchants m cross join public.automation_settings s
       where m.id=p_master_merchant_id and s.id=1),false);
$$;

-- The previous version stopped on a duplicate transaction link. Candidates
-- that are already linked are now ignored, allowing the remaining unique rows
-- to be recovered in the same sweep.
create or replace function public.link_wallet_sms_to_paid_transactions(p_window_minutes integer default 15)
returns jsonb language plpgsql security definer set search_path=public,pg_temp set timezone='UTC' as $function$
declare v_linked integer:=0;
begin
with paid as (
 select m.tx_id,m.amount,regexp_replace(coalesce(m.receiving_wallet,m.to_account_number,''),'\D','','g') wallet,
 coalesce(case when m.created_utc~'^\d{4}-\d{2}-\d{2}' then m.created_utc::timestamptz end,m.first_seen_at,m.last_status_change) paid_time
 from public.maven_transactions m
 where upper(m.status)='PAID' and m.amount is not null and coalesce(m.receiving_wallet,m.to_account_number) is not null
 and not exists(select 1 from public.inbound_sms z where z.consumed_by_tx_id=m.tx_id)
 and not exists(select 1 from public.sms_maven_matches old where old.tx_id=m.tx_id)
), sms as (
 select s.id,s.amount,regexp_replace(coalesce(s.confirmed_wallet_number,s.receiver_number,
 (select h.wallet_number from public.wallet_device_history h where h.device=coalesce(s.webhook_name,s.device_name) and h.changed_at<=s.received_at order by h.changed_at desc limit 1),''),'\D','','g') wallet,
 s.received_at,s.webhook_name
 from public.inbound_sms s
 where s.sms_category='deposit' and s.amount is not null and s.received_at>=now()-make_interval(mins=>greatest(p_window_minutes,1))
 and s.consumed_by_tx_id is null and not coalesce(s.is_blocked,false) and coalesce(s.is_duplicate,false)=false
 and not exists(select 1 from public.sms_maven_matches old where old.sms_id=s.id)
), cand as (
 select p.tx_id,s.id sms_id,p.amount mv_amount,s.amount sms_amount,p.wallet,p.paid_time,s.received_at,s.webhook_name,
 abs(extract(epoch from(s.received_at-p.paid_time))) sec_diff,
 row_number() over(partition by p.tx_id order by abs(extract(epoch from(s.received_at-p.paid_time))),s.id) tx_rank,
 count(*) over(partition by p.tx_id) tx_candidates,
 row_number() over(partition by s.id order by abs(extract(epoch from(s.received_at-p.paid_time))),p.tx_id) sms_rank,
 count(*) over(partition by s.id) sms_candidates
 from paid p join sms s on s.amount=p.amount and p.wallet<>'' and s.wallet<>'' and right(p.wallet,10)=right(s.wallet,10)
 and p.paid_time is not null and abs(extract(epoch from(s.received_at-p.paid_time)))<=greatest(p_window_minutes,1)*60
), chosen as (
 select c.* from cand c where c.tx_rank=1 and c.sms_rank=1 and c.tx_candidates=1 and c.sms_candidates=1
 and not exists(select 1 from public.sms_maven_matches old where old.tx_id=c.tx_id or old.sms_id=c.sms_id)
), ins as (
 insert into public.sms_maven_matches(sms_id,tx_id,receiving_wallet,sms_amount,mv_amount,received_at,mv_time,sec_diff,webhook_name,matched_at)
 select sms_id,tx_id,wallet,sms_amount,mv_amount,received_at,paid_time,sec_diff,webhook_name,now() from chosen
 on conflict(sms_id) do nothing returning sms_id,tx_id
)
update public.inbound_sms s set consumed_by_tx_id=i.tx_id,matched_transaction_id=i.tx_id,matched=true,match_status='matched_paid',
 auto_match_score=100,review_required=false,processed_at=coalesce(s.processed_at,now()),
 notes=concat_ws('; ',nullif(s.notes,''),'linked_to_paid_by_wallet_amount_time') from ins i where s.id=i.sms_id;
get diagnostics v_linked=row_count;
return jsonb_build_object('linked',v_linked,'window_minutes',p_window_minutes);
end;$function$;

create or replace function public.evaluate_and_dispatch_ngpay_decision_core(p_tx_id bigint)
returns text language plpgsql set search_path=public as $function$
declare v_tx public.maven_transactions; v_mm public.master_merchants; v_rule public.automation_rules_scoped;
 v_seen timestamptz; v_pending_minutes numeric; v_service_key text; v_request_id bigint; v_evidence int;
begin
 select * into v_tx from public.maven_transactions where tx_id=p_tx_id;
 if v_tx.tx_id is null then return 'not_found'; end if;
 if v_tx.status is distinct from 'PENDING' then return 'not_pending'; end if;
 if v_tx.gateway is distinct from 'NagupayP2P' then return 'unsupported_gateway'; end if;
 v_seen:=coalesce(v_tx.first_seen_at,nullif(v_tx.created_utc,'')::timestamptz); if v_seen is null then return 'no_timestamp'; end if;
 select * into v_mm from public.master_merchants where lower(slug)=case when lower(v_tx.gateway)='nagupayp2p' then 'ngpay' else lower(v_tx.gateway) end or lower(name)=case when lower(v_tx.gateway)='nagupayp2p' then 'ngpay' else lower(v_tx.gateway) end order by case when lower(slug)='ngpay' then 0 else 1 end limit 1;
 if v_mm.id is null then return 'master_merchant_not_found'; end if;
 if not public.is_source_enabled(v_mm.id) then return 'source_disabled'; end if;
 select * into v_rule from public.automation_rules_scoped r where r.enabled
   and (r.master_merchant is null or lower(r.master_merchant) in(lower(v_mm.slug),lower(v_mm.name)))
   and (r.merchant is null or r.merchant=v_tx.merchant) and (r.sub_merchant is null or r.sub_merchant=v_tx.sub_merchant)
   and (r.payment_method is null or r.payment_method=v_tx.payment_method) and v_tx.amount between r.min_amount and r.max_amount
   order by r.priority desc limit 1;
 if v_rule.id is null then return 'no_rule_match'; end if;
 if v_rule.action_type='approve' then
   select count(*) into v_evidence from public.inbound_sms s where not coalesce(s.is_blocked,false) and s.amount=v_tx.amount
     and coalesce(s.sms_category,'') in('deposit','received','income')
     and (s.matched_transaction_id=v_tx.tx_id or s.consumed_by_tx_id=v_tx.tx_id or
       (s.received_at between v_seen-interval '15 minutes' and v_seen+interval '90 minutes' and s.balance_after is not null
        and regexp_replace(coalesce(s.confirmed_wallet_number,s.wallet_number,s.receiver_number,''),'\D','','g')=regexp_replace(coalesce(v_tx.receiving_wallet,v_tx.to_account_number,''),'\D','','g')));
   if v_evidence=0 then return 'approve_blocked_no_payment_evidence'; end if;
 elsif v_rule.action_type='decline' then
   v_pending_minutes:=extract(epoch from(now()-v_seen))/60.0; if v_pending_minutes < greatest(coalesce(v_rule.time_window_minutes,5),5) then return 'waiting_grace_period'; end if;
 else return 'unknown_action_type'; end if;
 select decrypted_secret into v_service_key from vault.decrypted_secrets where name='daily_report_service_key'; if v_service_key is null then return 'dispatch_key_missing'; end if;
 select net.http_post(url:='https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),body:=jsonb_build_object('tx_id',p_tx_id,'decision',case v_rule.action_type when 'approve' then 'PAID' else 'DECLINED' end,'actor_name','automation-engine','remark','rule:'||v_rule.id::text||' scope:'||v_rule.scope_type)) into v_request_id;
 return 'dispatched_'||v_rule.action_type||'_request_'||v_request_id::text;
end;$function$;
