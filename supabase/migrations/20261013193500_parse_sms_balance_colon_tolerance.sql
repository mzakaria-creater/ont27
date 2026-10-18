-- Mirrors supabase/functions/sms-inbound/index.ts's extractBalance() fix.
--
-- Vodafone Cash's "تم استلام" deposit confirmation states the balance as
-- "رصيدك الحالي: 1327.79 جنيه" -- a colon between the label and the number
-- that this regex did not tolerate, so balance_after came back null for
-- every single Vodafone deposit SMS (confirmed live: 0 of 273 in a 24h
-- window had a balance, vs 531 of 634 Orange ones, which never carry that
-- colon). This is the DB-side fallback fill_sms_parsed_fields() calls when
-- the edge function's own extraction already returned null, so it hit the
-- identical bug a second time.
create or replace function public.parse_sms_balance(p_message text)
returns numeric
language plpgsql
immutable
as $function$
declare m text[];
begin
  if p_message is null then return null; end if;
  m := regexp_match(p_message, '(?:رصيدك\s*الحالي|رصيد\s*اورن[^\s]\s*كاش\s*الجديد|رصيد\s*محفظتك\s*الحالي|رصيدك\s*الجديد|الرصيد\s*الحالي)\s*[:：]?\s*([0-9][0-9.,]*)');
  if m is null then return null; end if;
  begin return replace(m[1], ',', '')::numeric; exception when others then return null; end;
end $function$;
