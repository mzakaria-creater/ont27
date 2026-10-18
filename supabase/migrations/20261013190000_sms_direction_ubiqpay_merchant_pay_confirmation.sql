-- Mirrors supabase/functions/sms-inbound/index.ts's smsDirection()/isIncoming fix.
--
-- "لتأكيد دفع مبلغ X ... ل <merchant>" is Vodafone Cash's merchant/bill-pay
-- COMPLETED-payment confirmation. Confirmed live: 40 of 41 "Ubiqpay
-- Technology Ltd." merchant-pay SMS were stuck at sms_category "unknown"
-- because this exact clause matched neither is_out nor is_in in
-- sms_direction(), so classification fell through to wallet-resolution
-- success (which only worked when the forwarding device mapped to exactly
-- one wallet) instead of recognizing this as an unambiguous deposit.
--
-- Deliberately narrow to "لتأكيد" + "دفع مبلغ" together: Orange's
-- "ادفع X (merchant)" and Fawry's "To pay X for merchant" are PENDING
-- payment-request notifications (money not yet received), not confirmations
-- that a payment arrived, and must never be classified as a deposit.
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
  is_in  := c ~ '(تم\s*استلام|استلمت|استقبلت|إيداع|ايداع|تم\s*اضافة|تم\s*إضافة|لتأكيد\s*دفع\s*مبلغ)'
         or c ~* '(received|deposit|credited)';
  if is_out then return 'out'; end if;   -- a successful outgoing action always wins
  if is_in  then return 'in';  end if;
  return 'unknown';
end $function$;
