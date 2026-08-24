-- Technical SMS/matching failures are operational gaps, not client risk.
-- Only explicit risk-evidence declines may contribute to the 24-hour block.
create or replace function public.trg_auto_blacklist_repeat_fn()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_phone text;
  v_count integer;
begin
  if new.decision not in ('auto_declined', 'manually_declined') then
    return new;
  end if;

  -- An explicit, auditable risk reason is required. In particular, no SMS,
  -- no clean match, timeouts, and an already-blocked phone do not qualify.
  if coalesce(new.decision_reason, '') !~* '(fraud|scam|risk evidence|wallet mismatch|wrong wallet|blocked country|blocked city|blacklist evidence|احتيال|اشتباه احتيال|مخاطر مثبتة|محفظة مخالفة|محفظة غير مطابقة|دولة محظورة|مدينة محظورة|دليل قائمة سوداء)' then
    return new;
  end if;

  select mt.sender_number into v_phone
  from public.maven_transactions mt
  where mt.tx_id = new.tx_id;

  if v_phone is null or length(v_phone) < 10 then
    return new;
  end if;

  -- Retention/known-good clients always go to review instead of auto-block.
  if exists (
    select 1
    from public.api_risk_whitelist w
    where w.type = 'phone'
      and public.norm_phone10(w.value) = public.norm_phone10(v_phone)
  ) then
    return new;
  end if;

  select count(*) into v_count
  from public.review_queue rq
  join public.maven_transactions mt2 on mt2.tx_id = rq.tx_id
  where rq.decision in ('auto_declined', 'manually_declined')
    and rq.created_at > now() - interval '24 hours'
    and public.norm_phone10(mt2.sender_number) = public.norm_phone10(v_phone)
    and coalesce(rq.decision_reason, '') ~* '(fraud|scam|risk evidence|wallet mismatch|wrong wallet|blocked country|blocked city|blacklist evidence|احتيال|اشتباه احتيال|مخاطر مثبتة|محفظة مخالفة|محفظة غير مطابقة|دولة محظورة|مدينة محظورة|دليل قائمة سوداء)';

  if v_count >= 6 then
    insert into public.api_risk_blacklist (type, value, reason, created_at)
    values ('phone', v_phone, format('⛔ حظر تلقائي: %s رفض مخاطر مثبت خلال 24 ساعة', v_count), now())
    on conflict (type, value, merchant_id) do update
      set reason = excluded.reason;
  end if;

  return new;
end;
$function$;
