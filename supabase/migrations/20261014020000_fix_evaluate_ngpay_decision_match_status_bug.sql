-- evaluate_and_dispatch_ngpay_decision_core() claims its evidence SMS with
-- an UPDATE that sets consumed_by_tx_id/matched_transaction_id/matched=true
-- but never touches match_status or review_required. match_status's column
-- default is 'unmatched', so every SMS claimed through this path (the
-- automation rule engine's approve-dispatch evidence claim) ended up with
-- matched=true, consumed_by_tx_id set (i.e. genuinely linked to a real
-- transaction) AND match_status='unmatched' + review_required=true at the
-- same time -- a self-contradictory row that makes an already-linked SMS
-- still show up in "needs review"/"unmatched" views, wasting staff time
-- re-investigating something already resolved.
--
-- Confirmed live: 1,792 affected rows overall, overwhelmingly Orange Cash
-- (1,625 vs 167) -- Orange's phone-less sender identity (embedded in
-- sender_name instead, e.g. "hany fayez rezk allah marzouk-01273281616")
-- makes it depend heavily on this rule engine's use_unique_amount evidence
-- fallback to ever get claimed at all, unlike Vodafone which almost always
-- carries sender_number directly and gets matched through smsMatcher.ts's
-- repairPaidSmsMatches or assign_unique_sms_to_maven_tx instead, both of
-- which already set match_status correctly.
create or replace function public.evaluate_and_dispatch_ngpay_decision_core(p_tx_id bigint)
returns text
language plpgsql
set search_path to 'public'
as $function$
declare
  v_tx public.maven_transactions;
  v_mm public.master_merchants;
  v_settings public.automation_settings;
  v_rule public.automation_rules_scoped;
  v_seen timestamptz;
  v_wallet text;
  v_pending_minutes numeric;
  v_service_key text;
  v_request_id bigint;
  v_evidence int;
  v_amount_tolerance numeric;
  v_unique_count int;
  v_prior_paid boolean;
  v_retained boolean;
  v_balance_candidate boolean;
  v_blacklisted boolean;
  v_blacklisted_exact_sms boolean := false;
  v_manual_review_at timestamptz;
  v_any_approve_rule boolean := false;
  v_any_decline_rule boolean := false;
  v_evidence_sms_id bigint;
begin
  select * into v_tx from public.maven_transactions where tx_id = p_tx_id for update;
  if v_tx.tx_id is null then return 'not_found'; end if;
  if v_tx.status is distinct from 'PENDING' then return 'not_pending'; end if;
  if lower(coalesce(v_tx.gateway, '')) <> 'nagupayp2p' then return 'unsupported_gateway'; end if;

  SELECT EXISTS (
    SELECT 1
    FROM public.inbound_sms s
    WHERE (s.consumed_by_tx_id = v_tx.tx_id OR s.matched_transaction_id = v_tx.tx_id OR s.maven_transaction_id = v_tx.tx_id::text)
      AND NOT coalesce(s.is_blocked, false)
      AND NOT coalesce(s.is_duplicate, false)
      AND coalesce(s.auto_match_score, 0) = 100
      AND s.amount = v_tx.amount
      AND right(regexp_replace(coalesce(s.sender_number, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)
      AND right(regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(v_tx.receiving_wallet, v_tx.to_account_number, ''), '\D', '', 'g'), 10)
  ) INTO v_blacklisted_exact_sms;
  IF v_blacklisted_exact_sms THEN
    SELECT greatest(max(s.processed_at), max(s.received_at)) INTO v_manual_review_at
    FROM public.inbound_sms s
    WHERE (s.consumed_by_tx_id = v_tx.tx_id OR s.matched_transaction_id = v_tx.tx_id OR s.maven_transaction_id = v_tx.tx_id::text);
    IF v_manual_review_at IS NULL OR now() < v_manual_review_at + interval '15 minutes' THEN
      RETURN 'blacklisted_exact_sms_manual_review';
    END IF;
  END IF;
  if not v_blacklisted_exact_sms and nullif(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), '') is not null
     and exists (
       select 1 from public.api_risk_blacklist b
       where lower(coalesce(b.type, '')) = 'phone'
         and right(regexp_replace(coalesce(b.value, ''), '\D', '', 'g'), 10)
             = right(regexp_replace(v_tx.sender_number, '\D', '', 'g'), 10)
     ) then
    select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'daily_report_service_key';
    if v_service_key is null then return 'blacklisted_phone_key_missing'; end if;
    select net.http_post(
      url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),
      body := jsonb_build_object('tx_id', p_tx_id, 'decision', 'DECLINED',
        'actor_name', 'automation-engine-blacklist',
        'remark', 'Auto-decline: sender phone is blacklisted (amount-independent)'),
      timeout_milliseconds := 30000
    ) into v_request_id;
    return 'dispatched_decline_blacklisted_phone_request_' || v_request_id::text;
  end if;

  select * into v_settings from public.automation_settings where id = 1;
  if not coalesce(v_settings.automation_enabled, false) then return 'automation_disabled'; end if;
  if not coalesce(v_settings.ngpay_enabled, false) then return 'ngpay_disabled'; end if;
  if v_tx.amount is null or v_tx.amount <= 0 then return 'invalid_amount'; end if;
  if v_settings.max_auto_amount is not null and v_tx.amount > v_settings.max_auto_amount then return 'above_auto_amount_limit'; end if;

  v_seen := coalesce(v_tx.first_seen_at, public.parse_maven_utc(v_tx.created_utc));
  if v_seen is null then return 'no_timestamp'; end if;
  v_wallet := regexp_replace(coalesce(v_tx.receiving_wallet, v_tx.to_account_number, ''), '\D', '', 'g');

  select exists (
    select 1 from public.api_risk_blacklist b
    where b.type = 'phone'
      and right(regexp_replace(b.value, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)
      and right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10) <> ''
  ) into v_blacklisted;
  if v_blacklisted and not v_blacklisted_exact_sms then
    select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'daily_report_service_key';
    if v_service_key is null then return 'dispatch_key_missing'; end if;
    select net.http_post(
      url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
      body := jsonb_build_object('tx_id', p_tx_id, 'decision', 'DECLINED', 'actor_name', 'automation-engine',
        'remark', 'sender_blacklisted'),
      timeout_milliseconds := 30000
    ) into v_request_id;
    return 'dispatched_decline_blacklisted_sender_' || v_request_id::text;
  end if;

  select * into v_mm from public.master_merchants
  where lower(slug) = 'ngpay' or lower(name) = 'ngpay'
  order by case when lower(slug) = 'ngpay' then 0 else 1 end
  limit 1;
  if v_mm.id is null then return 'master_merchant_not_found'; end if;
  if not public.is_source_enabled(v_mm.id) then return 'source_disabled'; end if;

  for v_rule in
    select * from public.automation_rules_scoped r
    where r.enabled and r.action_type = 'approve'
      and (r.master_merchant is null or lower(r.master_merchant) in (lower(v_mm.slug), lower(v_mm.name)))
      and (r.merchant is null or r.merchant = v_tx.merchant)
      and (r.sub_merchant is null or r.sub_merchant = v_tx.sub_merchant)
      and (r.payment_method is null or r.payment_method = v_tx.payment_method)
      and (r.account_wallet is null or regexp_replace(r.account_wallet, '\D', '', 'g') = v_wallet)
      and v_tx.amount between r.min_amount and least(r.max_amount, coalesce(v_settings.max_auto_amount, r.max_amount))
    order by r.priority desc, r.updated_at desc
  loop
    v_any_approve_rule := true;

    if v_rule.first_deposit_only then
      if v_tx.amount > 5000 then continue; end if;
      select exists (
        select 1 from public.maven_transactions prior
        where prior.tx_id <> v_tx.tx_id and prior.status = 'PAID'
          and prior.created_at_utc < v_tx.created_at_utc
          and regexp_replace(coalesce(prior.sender_number, ''), '\D', '', 'g') = regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g')
          and regexp_replace(coalesce(prior.sender_number, ''), '\D', '', 'g') <> ''
      ) into v_prior_paid;
      if v_prior_paid then continue; end if;
    end if;

    v_amount_tolerance := case when v_rule.use_near_amount then 1 else 0 end;

    select s.id into v_evidence_sms_id
    from public.inbound_sms s
    where not coalesce(s.is_blocked, false) and not coalesce(s.is_duplicate, false)
      and abs(s.amount - v_tx.amount) <= v_amount_tolerance
      and coalesce(s.sms_category, '') in ('deposit', 'received', 'income')
      and (
        s.matched_transaction_id = v_tx.tx_id or s.consumed_by_tx_id = v_tx.tx_id
        or (
          s.received_at between v_seen - interval '15 minutes' and v_seen + interval '90 minutes'
          and (regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = v_wallet or (regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = '' and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) <> '' and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)))
          and s.balance_after is not null
          and (
            (nullif(s.sender_number, '') is not null and regexp_replace(s.sender_number, '\D', '', 'g') = regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'))
            or (nullif(s.sender_number, '') is null and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) <> '' and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10))
            or (v_rule.use_crm_matching and exists (
              select 1 from public.crm_clients c
              where regexp_replace(coalesce(c.normalized_phone, ''), '\D', '', 'g') = regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g')
                and exists (select 1 from unnest(coalesce(c.sms_names, '{}'::text[])) n where lower(trim(n)) = lower(trim(s.sender_name)))
            ))
          )
        )
      )
    order by (s.matched_transaction_id = v_tx.tx_id or s.consumed_by_tx_id = v_tx.tx_id) desc,
             abs(extract(epoch from (s.received_at - v_seen)))
    for update of s skip locked
    limit 1;
    v_evidence := case when v_evidence_sms_id is null then 0 else 1 end;

    if v_evidence = 0 and v_rule.use_unique_amount then
      select count(*) into v_unique_count
      from public.inbound_sms s
      where not coalesce(s.is_blocked, false) and not coalesce(s.is_duplicate, false)
        and s.consumed_by_tx_id is null and coalesce(s.sms_category, '') in ('deposit', 'received', 'income')
        and abs(s.amount - v_tx.amount) <= v_amount_tolerance
        and s.received_at between v_seen - interval '15 minutes' and v_seen + interval '90 minutes'
        and regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = v_wallet
        and not public.sms_name_owned_only_by_other_phone(s.sender_name, v_tx.sender_number)
        and not (
          right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) <> ''
          and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10)
              <> right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)
        );
      if v_unique_count = 1 then
        select s.id into v_evidence_sms_id
        from public.inbound_sms s
        where not coalesce(s.is_blocked, false) and not coalesce(s.is_duplicate, false)
          and s.consumed_by_tx_id is null and coalesce(s.sms_category, '') in ('deposit', 'received', 'income')
          and abs(s.amount - v_tx.amount) <= v_amount_tolerance
          and s.received_at between v_seen - interval '15 minutes' and v_seen + interval '90 minutes'
          and regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = v_wallet
          and not public.sms_name_owned_only_by_other_phone(s.sender_name, v_tx.sender_number)
        and not (
            right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) <> ''
            and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10)
                <> right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)
          )
        for update of s skip locked
        limit 1;
        v_evidence := case when v_evidence_sms_id is null then 0 else 1 end;
      end if;
    end if;

    if v_evidence > 0 then
      -- Was missing match_status/review_required -- left every claimed SMS
      -- with match_status at its column default 'unmatched' and
      -- review_required still true despite being genuinely linked
      -- (matched=true, consumed_by_tx_id set). Confirmed live: 1,792 rows
      -- affected this way, 1,625 of them Orange Cash.
      update public.inbound_sms
      set consumed_by_tx_id = v_tx.tx_id,
          matched_transaction_id = coalesce(matched_transaction_id, v_tx.tx_id),
          matched = true,
          match_status = 'auto_rule_matched',
          review_required = false
      where id = v_evidence_sms_id
        and (consumed_by_tx_id is null or consumed_by_tx_id = v_tx.tx_id);
      if not found then
        v_evidence := 0;
      end if;
    end if;

    if v_evidence > 0 then
      if not exists (
        select 1 from public.inbound_sms assigned_sms
        where assigned_sms.consumed_by_tx_id = v_tx.tx_id
           or assigned_sms.matched_transaction_id = v_tx.tx_id
           or assigned_sms.maven_transaction_id = v_tx.tx_id::text
      ) then
        return 'approve_blocked_sms_not_assigned';
      end if;

      select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'daily_report_service_key';
      if v_service_key is null then return 'dispatch_key_missing'; end if;
      select net.http_post(
        url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
        body := jsonb_build_object('tx_id', p_tx_id, 'decision', 'PAID', 'actor_name', 'automation-engine',
          'remark', 'rule:' || v_rule.id::text || ' scope:' || v_rule.scope_type,
          'allow_reversal', true)
      ) into v_request_id;
      return 'dispatched_approve_request_' || v_request_id::text;
    end if;
  end loop;

  for v_rule in
    select * from public.automation_rules_scoped r
    where r.enabled and r.action_type = 'decline'
      and (r.master_merchant is null or lower(r.master_merchant) in (lower(v_mm.slug), lower(v_mm.name)))
      and (r.merchant is null or r.merchant = v_tx.merchant)
      and (r.sub_merchant is null or r.sub_merchant = v_tx.sub_merchant)
      and (r.payment_method is null or r.payment_method = v_tx.payment_method)
      and (r.account_wallet is null or regexp_replace(r.account_wallet, '\D', '', 'g') = v_wallet)
      and v_tx.amount between r.min_amount and least(r.max_amount, coalesce(v_settings.max_auto_amount, r.max_amount))
    order by r.priority desc, r.updated_at desc
  loop
    v_any_decline_rule := true;
    if not coalesce(v_settings.auto_decline_enabled, false) then return 'auto_decline_disabled'; end if;

    select exists (
      select 1 from public.crm_clients c
      where regexp_replace(coalesce(c.normalized_phone, ''), '\D', '', 'g') = regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g')
        and coalesce(c.is_repeat_client, false)
        and coalesce(c.approved_transactions, 0) > 0
        and coalesce(c.approved_transactions, 0) > coalesce(c.declined_transactions, 0)
    ) into v_retained;
    if v_retained and extract(epoch from (now() - v_seen)) / 60.0 < 8 then
      return 'waiting_grace_period';
    end if;

    v_pending_minutes := extract(epoch from (now() - v_seen)) / 60.0;
    if v_pending_minutes < greatest(coalesce(v_rule.time_window_minutes, 5), coalesce(v_settings.decline_grace_minutes, 5), 5) then
      return 'waiting_grace_period';
    end if;

    if coalesce(v_settings.use_balance_timing_matching, false) then
      select exists (
        select 1 from public.inbound_sms s
        where s.consumed_by_tx_id is null and not coalesce(s.is_blocked, false) and not coalesce(s.is_duplicate, false)
          and coalesce(s.sms_category, '') in ('deposit', 'received', 'income')
          and s.amount = v_tx.amount
          and (regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = v_wallet or (regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = '' and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) <> '' and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)))
          and s.received_at between v_seen - interval '10 minutes' and v_seen + interval '10 minutes'
      ) into v_balance_candidate;
      if v_balance_candidate then return 'decline_blocked_candidate_sms_exists'; end if;
    end if;

    select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'daily_report_service_key';
    if v_service_key is null then return 'dispatch_key_missing'; end if;
    select net.http_post(
      url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
      body := jsonb_build_object('tx_id', p_tx_id, 'decision', 'DECLINED', 'actor_name', 'automation-engine',
        'remark', 'rule:' || v_rule.id::text || ' scope:' || v_rule.scope_type),
      timeout_milliseconds := 30000
    ) into v_request_id;
    return 'dispatched_decline_request_' || v_request_id::text;
  end loop;

  if not v_any_approve_rule and not v_any_decline_rule then return 'no_rule_match'; end if;
  return 'approve_blocked_no_payment_evidence';
end;
$function$;

-- Backfill: correct every historical row this bug produced. Purely a status
-- bookkeeping fix -- does not touch amount, wallet, or the actual linkage
-- (consumed_by_tx_id/matched_transaction_id), which was always correct.
update public.inbound_sms
set match_status = 'auto_rule_matched', review_required = false
where matched = true and match_status = 'unmatched';
