-- Records the SMS parsing/direction functions that already run in production.
-- Direction is decided from the receipt clause only (never from promo ads that
-- Orange Cash appends after "رقم المعاملة <digits>").

create or replace function public.sms_core_text(p_msg text)
returns text language sql immutable as $f$
  select coalesce(
    substring(coalesce(p_msg,'') from '^[\s\S]*?رقم\s*(?:المعاملة|العملية)\s*[:：]?\s*\d+'),
    split_part(coalesce(p_msg,''), E'\n\n', 1)
  )
$f$;

create or replace function public.sms_direction(p_msg text)
returns text language plpgsql immutable as $f$
declare c text := public.sms_core_text(p_msg);
        is_out boolean; is_in boolean;
begin
  if c ~ 'لديك\s*عملية\s*سحب' and c !~ 'بمبلغ' then return 'notice'; end if;
  is_out := c ~ '(عملية\s*سحب\s*ناجحة|تحويل\s*أموال\s*ناجحة|رسوم\s*السحب|رسوم\s*التحويل|تم\s*خصم|تم\s*سحب|تم\s*تحويل|لرقم|تحويل\s*(إلى|الي|الى))'
         or c ~* '(withdraw|debit|paid out)';
  is_in  := c ~ '(تم\s*استلام|استلمت|استقبلت|إيداع|ايداع|تم\s*اضافة|تم\s*إضافة)'
         or c ~* '(received|deposit|credited)';
  if is_out then return 'out'; end if;   -- a successful outgoing action always wins
  if is_in  then return 'in';  end if;
  return 'unknown';
end $f$;

create or replace function public.parse_sms_balance(p_message text)
returns numeric language plpgsql immutable as $f$
declare m text[];
begin
  if p_message is null then return null; end if;
  m := regexp_match(p_message, '(?:رصيدك\s*الحالي|رصيد\s*اورن[^\s]\s*كاش\s*الجديد|رصيد\s*محفظتك\s*الحالي|رصيدك\s*الجديد|الرصيد\s*الحالي)\s*([0-9][0-9.,]*)');
  if m is null then return null; end if;
  begin return replace(m[1], ',', '')::numeric; exception when others then return null; end;
end $f$;

create or replace function public.parse_sms_sender_phone(p_message text)
returns text language plpgsql immutable as $f$
declare m text[];
begin
  if p_message is null then return null; end if;
  m := regexp_match(p_message, 'من\s+(?:(?:\+|00)?20|0)(1[0125][0-9]{8})(?![0-9])');
  if m is null then return null; end if;
  return '0' || m[1];
end $f$;

create or replace function public.fill_sms_parsed_fields()
returns trigger language plpgsql as $f$
declare d text;
begin
  if coalesce(new.message,'') ~ '(بمبلغ|مبلغ)' and coalesce(new.message,'') !~ 'From\s*:\s*\+' then
    d := public.sms_direction(new.message);
    if d = 'out' and coalesce(new.sms_category,'') in ('deposit','received','income','unknown') then
      new.sms_category := 'withdrawal';
    elsif d = 'in' and coalesce(new.sms_category,'') in ('withdrawal','expense','unknown') then
      new.sms_category := 'deposit';
    end if;
  end if;
  if new.balance_after is null then
    new.balance_after := public.parse_sms_balance(new.message);
  end if;
  if coalesce(new.sms_category,'') in ('deposit','received','income')
     and nullif(new.sender_number,'') is null and nullif(new.sender_name,'') is null then
    new.sender_number := public.parse_sms_sender_phone(new.message);
  end if;
  return new;
end $f$;

drop trigger if exists a0_fill_sms_parsed_fields on public.inbound_sms;
create trigger a0_fill_sms_parsed_fields before insert on public.inbound_sms
  for each row execute function public.fill_sms_parsed_fields();
