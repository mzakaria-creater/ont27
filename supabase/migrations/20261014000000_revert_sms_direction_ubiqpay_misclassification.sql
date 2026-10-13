-- Reverts 20261013190000_sms_direction_ubiqpay_merchant_pay_confirmation.sql.
--
-- That migration classified "لتأكيد دفع مبلغ X ... ل <merchant>" (e.g.
-- "Ubiqpay Technology Ltd.") as a deposit, reasoning that "لتأكيد" (confirm)
-- implied a completed payment to us. This was wrong: per the account owner
-- directly, and independently per two different staff (ahmedmano.solly,
-- minafx2@gmail.com) who had each already manually blocked an occurrence of
-- this exact message as irrelevant BEFORE the 2026-10-13 change, this is a
-- Vodafone Cash merchant/bill-pay confirmation for a SEPARATE merchant, not a
-- deposit to us. Must stay "unknown" like Orange's "ادفع X (merchant)" /
-- Fawry's "To pay X for merchant" -- never classified as a deposit, never
-- shown as financial evidence, never eligible for automation.
--
-- Mirrors supabase/functions/sms-inbound/index.ts's smsDirection()/isIncoming
-- revert (deployed as sms-inbound version 28).
create or replace function public.sms_direction(p_msg text)
returns text
language plpgsql
immutable
as $function$
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
end $function$;

-- Correct the 3 rows this bug affected while it was live (2026-10-13 to
-- 2026-10-14): 1014176 (unblocked), 1014273 (blocked by ahmedmano.solly),
-- 1014429 (blocked by minafx2@gmail.com). Scoped to the exact message
-- pattern so this never touches an unrelated row; is_blocked/block_reason/
-- blocked_by audit trail on the two already-blocked rows is left untouched.
update inbound_sms
set sms_category = 'unknown'
where id in (1014429, 1014273, 1014176)
  and raw_sms ~ 'لتأكيد\s*دفع\s*مبلغ';
