-- Automation engine hardening (applied to production 2026-10-11).
--  1. SMS from unknown-device carry no wallet. They are now accepted as evidence
--     (and block auto-decline) when the sender phone matches exactly, either in
--     sender_number or embedded in sender_name, with the same amount and window.
--  2. The unique-amount fallback no longer treats an SMS as evidence when its
--     sender name is owned in the CRM only by other phones.
-- Idempotent patch of evaluate_and_dispatch_ngpay_decision_core.

create or replace function public.sms_name_owned_only_by_other_phone(p_name text, p_sender text)
returns boolean language sql stable set search_path to 'public' as $f$
  select nullif(trim(coalesce(p_name,'')),'') is not null
    and exists (
      select 1 from public.crm_clients c
      where cardinality(coalesce(c.sms_names,'{}'::text[])) > 0
        and lower(trim(p_name)) = any (select lower(trim(n)) from unnest(c.sms_names) n)
    )
    and not exists (
      select 1 from public.crm_clients c
      where right(regexp_replace(coalesce(c.normalized_phone,''),'\D','','g'),10) = right(regexp_replace(coalesce(p_sender,''),'\D','','g'),10)
        and right(regexp_replace(coalesce(p_sender,''),'\D','','g'),10) <> ''
        and lower(trim(p_name)) = any (select lower(trim(n)) from unnest(coalesce(c.sms_names,'{}'::text[])) n)
    );
$f$;

do $mig$
declare
  src text;
  strong text := $s$right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) <> '' and right(regexp_replace(coalesce(nullif(s.sender_number, ''), s.sender_name, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)$s$;
  w_empty text := $s$regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = ''$s$;
  w_eq text := $s$regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g') = v_wallet$s$;
  r1_old text; r2_old text; r3_old text;
begin
  src := pg_get_functiondef('public.evaluate_and_dispatch_ngpay_decision_core'::regproc);
  if position('sms_name_owned_only_by_other_phone' in src) > 0 then
    raise notice 'automation core already patched; skipping';
    return;
  end if;

  r1_old := 'and ' || w_eq || E'\n          and s.balance_after is not null';
  r3_old := 'and ' || w_eq || E'\n          and s.received_at between v_seen - interval ''10 minutes''';
  r2_old := 'or (v_rule.use_crm_matching and exists (';
  if position(r1_old in src) = 0 or position(r2_old in src) = 0 or position(r3_old in src) = 0 then
    raise notice 'automation core has a different shape; skipping patch';
    return;
  end if;

  src := replace(src, r1_old, 'and (' || w_eq || ' or (' || w_empty || ' and ' || strong || '))' || E'\n          and s.balance_after is not null');
  src := replace(src, r2_old, 'or (nullif(s.sender_number, '''') is null and ' || strong || E')\n            or (v_rule.use_crm_matching and exists (');
  src := replace(src, r3_old, 'and (' || w_eq || ' or (' || w_empty || ' and ' || strong || '))' || E'\n          and s.received_at between v_seen - interval ''10 minutes''');
  src := regexp_replace(
    src,
    '(and not \(\s+right\(regexp_replace\(coalesce\(nullif\(s\.sender_number, ''''\), s\.sender_name)',
    E'and not public.sms_name_owned_only_by_other_phone(s.sender_name, v_tx.sender_number)\n        \\1',
    'g');
  execute src;
end
$mig$;
