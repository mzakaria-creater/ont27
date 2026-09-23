-- Walid Company LTD requires a human provider decision. SMS evidence may still
-- be linked, but no trigger, cron sweep, or queued rule may auto-approve it.

CREATE OR REPLACE FUNCTION public.trg_approve_on_sms_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_tx public.maven_transactions%rowtype;
  v_already_declined boolean;
  v_service_key text;
begin
  if new.consumed_by_tx_id is null or old.consumed_by_tx_id is not null then
    return new;
  end if;

  select * into v_tx from public.maven_transactions where tx_id = new.consumed_by_tx_id;
  if v_tx.tx_id is null or v_tx.status is distinct from 'PENDING' or v_tx.gateway is distinct from 'NagupayP2P' then
    return new;
  end if;

  if coalesce(v_tx.payment_method, '') ~* 'walid[[:space:]]+company[[:space:]]+ltd' then
    return new;
  end if;

  -- Instant approval is only safe when sender_number is known on BOTH sides
  -- and actually matches. Unknown sender identities fall through to cron.
  if nullif(new.sender_number,'') is null
     or nullif(v_tx.sender_number,'') is null
     or regexp_replace(new.sender_number,'\D','','g') <> regexp_replace(v_tx.sender_number,'\D','','g')
  then
    return new;
  end if;

  select exists (
    select 1 from public.deposit_decision_log l
    where l.tx_id = v_tx.tx_id
      and l.reason ilike '%Live provider status is DECLINED%refusing reversal%'
  ) into v_already_declined;

  if v_already_declined then
    update public.maven_transactions set status='DECLINED', last_status_change=now()
      where tx_id = v_tx.tx_id and status='PENDING';
    return new;
  end if;

  select decrypted_secret into v_service_key from vault.decrypted_secrets where name='daily_report_service_key';
  if v_service_key is null then return new; end if;

  perform net.http_post(
    url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),
    body := jsonb_build_object(
      'tx_id', v_tx.tx_id, 'decision', 'PAID', 'actor_name', 'automation-engine-instant',
      'remark', 'Instant approval on SMS link event (sender_number confirmed match)'
    ),
    timeout_milliseconds := 15000
  );

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.evaluate_and_dispatch_ngpay_decision(p_tx_id bigint)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
declare
  v_start timestamptz := clock_timestamp();
  v_out text;
  v_seen timestamptz;
  v_already_declined_on_provider boolean;
  v_payment_method text;
begin
  select payment_method into v_payment_method from public.maven_transactions where tx_id = p_tx_id;
  if coalesce(v_payment_method, '') ~* 'walid[[:space:]]+company[[:space:]]+ltd' then
    return 'auto_approval_disabled_walid_company_ltd';
  end if;

  select exists (
    select 1 from public.deposit_decision_log l
    where l.tx_id = p_tx_id
      and l.reason ilike '%Live provider status is DECLINED%refusing reversal%'
  ) into v_already_declined_on_provider;
  if v_already_declined_on_provider then
    update public.maven_transactions set status = 'DECLINED', last_status_change = now()
      where tx_id = p_tx_id and status = 'PENDING';
    return 'skipped_provider_already_declined_synced_locally';
  end if;

  begin perform public.assign_unique_sms_to_maven_tx(p_tx_id,600); exception when others then null; end;
  v_out := public.evaluate_and_dispatch_ngpay_decision_core(p_tx_id);

  begin
    select coalesce(first_seen_at, public.parse_maven_utc(created_utc)) into v_seen
      from public.maven_transactions where tx_id=p_tx_id;
    insert into public.auto_decision_trace(tx_id,started_at,duration_ms,outcome,tx_age_ms,caller)
    values (p_tx_id,v_start,extract(epoch from(clock_timestamp()-v_start))*1000,v_out,
      case when v_seen is null then null else extract(epoch from(v_start-v_seen))*1000 end,
      case when coalesce(current_setting('application_name',true),'') ilike '%cron%' then 'cron' else 'trigger' end);
  exception when others then null;
  end;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.evaluate_transaction_for_auto_decision(p_tx_id bigint)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
declare
  v_tx public.maven_transactions%rowtype;
  v_mm public.master_merchants;
  v_rule public.automation_rules_scoped;
begin
  select * into v_tx from public.maven_transactions where tx_id = p_tx_id;
  if v_tx.tx_id is null then return 'not_found'; end if;
  if v_tx.status is distinct from 'PENDING' then return 'not_pending'; end if;
  if coalesce(v_tx.payment_method, '') ~* 'walid[[:space:]]+company[[:space:]]+ltd' then
    return 'auto_approval_disabled_walid_company_ltd';
  end if;
  v_mm := public.resolve_master_merchant(p_tx_id);
  if not public.is_source_enabled(v_mm.id) then return 'source_disabled'; end if;
  select * into v_rule from public.automation_rules_scoped r
    where r.enabled and (r.master_merchant is null or r.master_merchant in (v_mm.code, v_mm.name))
      and (r.merchant is null or r.merchant = v_tx.merchant)
      and (r.sub_merchant is null or r.sub_merchant = v_tx.sub_merchant)
      and (r.payment_method is null or r.payment_method = v_tx.payment_method)
      and (r.provider is null or r.provider = v_mm.provider)
      and v_tx.amount between r.min_amount and r.max_amount
    order by r.priority desc limit 1;
  if v_rule.id is null then return 'no_rule_match'; end if;
  perform public.enqueue_decision(p_tx_id, v_rule.action_type, 'auto_trigger', v_rule.id::text, 'rule:' || v_rule.scope_type);
  return 'enqueued_' || v_rule.action_type;
end;
$function$;
