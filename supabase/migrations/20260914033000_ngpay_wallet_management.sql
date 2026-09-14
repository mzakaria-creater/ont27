-- Guarded NGPay wallet merge used by the management page.
-- wallet_device_map is keyed by to_account_number, so many rows cannot be
-- rewritten to one number without an explicit, auditable merge.

create or replace function public.merge_ngpay_wallets(
  p_wallet_numbers text[],
  p_new_wallet text,
  p_actor text default 'panel'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target text := regexp_replace(coalesce(p_new_wallet, ''), '\D', '', 'g');
  v_numbers text[] := array(
    select distinct regexp_replace(coalesce(value, ''), '\D', '', 'g')
    from unnest(coalesce(p_wallet_numbers, '{}'::text[])) as value
    where regexp_replace(coalesce(value, ''), '\D', '', 'g') ~ '^\d{8,20}$'
  );
  v_target_row public.wallet_device_map%rowtype;
  v_source public.wallet_device_map%rowtype;
  v_deleted integer := 0;
  v_found integer := 0;
  v_target_exists boolean := false;
begin
  if v_target !~ '^\d{8,20}$' or coalesce(array_length(v_numbers, 1), 0) = 0 then
    raise exception 'invalid_ngpay_merge_input';
  end if;

  select count(*) into v_found
  from public.wallet_device_map
  where to_account_number = any(v_numbers)
    and merchant = 'NGPay-MelBet-Prod';
  if v_found = 0 then raise exception 'ngpay_wallets_not_found'; end if;

  select * into v_target_row from public.wallet_device_map where to_account_number = v_target;
  v_target_exists := found;
  if v_target_exists and v_target_row.merchant is distinct from 'NGPay-MelBet-Prod' then
    raise exception 'target_wallet_belongs_to_other_merchant';
  end if;

  select * into v_source
  from public.wallet_device_map
  where to_account_number = any(v_numbers)
    and merchant = 'NGPay-MelBet-Prod'
  order by (to_account_number = v_target) desc, updated_at desc nulls last
  limit 1;

  insert into public.wallet_device_history(wallet_number, device, sim_slot, changed_by, note)
  select w.to_account_number, w.device, w.sim_slot, coalesce(p_actor, 'panel'),
         'NGPay explicit merge to ' || v_target
  from public.wallet_device_map w
  where w.to_account_number = any(v_numbers)
    and w.to_account_number <> v_target
    and w.merchant = 'NGPay-MelBet-Prod';

  delete from public.wallet_device_map
  where to_account_number = any(v_numbers)
    and to_account_number <> v_target
    and merchant = 'NGPay-MelBet-Prod';
  get diagnostics v_deleted = row_count;

  if not v_target_exists then
    insert into public.wallet_device_map(
      to_account_number, device, provider, payment_type, daily_limit,
      merchant, sim_slot, auto_inferred, confidence, updated_at
    ) values (
      v_target, v_source.device, v_source.provider, v_source.payment_type,
      v_source.daily_limit, 'NGPay-MelBet-Prod', v_source.sim_slot,
      false, 100, now()
    );
  else
    update public.wallet_device_map
    set merchant = 'NGPay-MelBet-Prod', auto_inferred = false,
        confidence = 100, updated_at = now()
    where to_account_number = v_target;
  end if;

  return jsonb_build_object('target', v_target, 'source_rows', v_found, 'deleted_rows', v_deleted, 'merged', true);
end;
$function$;

revoke all on function public.merge_ngpay_wallets(text[], text, text) from public;
grant execute on function public.merge_ngpay_wallets(text[], text, text) to service_role;
