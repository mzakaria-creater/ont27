-- This mutating SECURITY DEFINER reconciliation routine must never be exposed
-- to browser roles. It is invoked only by trusted server-side operations.
revoke execute on function public.link_wallet_sms_to_paid_transactions(integer) from public, anon, authenticated;
grant execute on function public.link_wallet_sms_to_paid_transactions(integer) to service_role;
