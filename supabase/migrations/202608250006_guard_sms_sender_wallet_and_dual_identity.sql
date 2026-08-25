create or replace function public.is_our_receiving_wallet(p_number text)
returns boolean language sql stable security invoker
set search_path = public, pg_temp
as $$
  select coalesce(exists (
    select 1 from public.wallet_device_map w
    where public.norm_phone10(w.to_account_number) = public.norm_phone10(p_number)
  ), false)
$$;
revoke all on function public.is_our_receiving_wallet(text) from public, anon, authenticated;
grant execute on function public.is_our_receiving_wallet(text) to service_role;

-- Patch the installed operational engine without copying its long, frequently
-- updated body into this repository. Every automatic candidate branch now
-- rejects an SMS whose sender is one of our receiving wallets. The existing
-- phone/account/CRM-name identity matching and all amount/balance/rule gates
-- remain unchanged.
do $$
declare v_def text; v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='evaluate_transaction_for_auto_decision_core';
  if v_def is null then raise exception 'automation core not found'; end if;
  v_before := v_def;
  v_def := replace(v_def,
    'AND s.consumed_by_tx_id IS NULL',
    'AND s.consumed_by_tx_id IS NULL AND NOT public.is_our_receiving_wallet(s.sender_number)');
  v_def := replace(v_def,
    'IF v_self_locked_sms.id IS NOT NULL THEN',
    'IF v_self_locked_sms.id IS NOT NULL AND NOT public.is_our_receiving_wallet(v_self_locked_sms.sender_number) THEN');
  if v_def = v_before then raise exception 'automation core patch markers not found'; end if;
  execute v_def;
end $$;

-- New-SMS reevaluation previously recognized only review_queue.source=maven,
-- while live NGPay rows use NGPay. Preserve the row's actual source.
do $$
declare v_def text; v_before text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='trg_phone_match_on_new_sms';
  if v_def is null then raise exception 'phone SMS trigger function not found'; end if;
  v_before := v_def;
  v_def := replace(v_def,
    'SELECT mt.tx_id, mt.amount, mt.merchant, mt.sub_merchant',
    'SELECT mt.tx_id, mt.amount, mt.merchant, mt.sub_merchant, rq.source');
  v_def := replace(v_def,
    'JOIN public.review_queue rq ON rq.tx_id = mt.tx_id AND rq.source = ''maven''',
    'JOIN public.review_queue rq ON rq.tx_id = mt.tx_id AND lower(rq.source) IN (''maven'',''ngpay'')');
  v_def := replace(v_def,
    'AND public.is_source_enabled(''maven'')',
    'AND public.is_source_enabled(rq.source)');
  v_def := replace(v_def,
    'r.tx_id, r.amount, r.merchant, r.sub_merchant, ''maven'');',
    'r.tx_id, r.amount, r.merchant, r.sub_merchant, r.source);');
  if v_def = v_before then raise exception 'phone SMS trigger patch markers not found'; end if;
  execute v_def;
end $$;
