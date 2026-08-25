create or replace function public.panel_wallet_sms_report_range(p_from date default null, p_to date default null)
returns table(wallet text, device text, merchant text, sms_count bigint, sms_amount numeric, deposits_count bigint, deposits_amount numeric, withdrawals_count bigint, withdrawals_amount numeric, unconfirmed bigint, balance numeric, first_balance numeric, last_sms timestamptz)
language sql stable security definer set search_path = public
as $$
  with s as (
    select * from inbound_sms
    where receiver_number is not null
      and (p_from is null or received_at >= p_from::timestamptz)
      and (p_to is null or received_at < (p_to + 1)::timestamptz)
  ), latest as (
    select distinct on (receiver_number) receiver_number, balance_after, device_name, merchant_name, received_at
    from s order by receiver_number, received_at desc nulls last
  ), earliest as (
    select distinct on (receiver_number) receiver_number, balance_after as first_balance
    from s where balance_after is not null order by receiver_number, received_at asc
  )
  select s.receiver_number, l.device_name, l.merchant_name,
    count(*), coalesce(sum(s.amount),0),
    count(*) filter (where s.sms_category='deposit'), coalesce(sum(s.amount) filter (where s.sms_category='deposit'),0),
    count(*) filter (where s.sms_category='withdrawal'), coalesce(sum(s.amount) filter (where s.sms_category='withdrawal'),0),
    count(*) filter (where s.sms_category='deposit' and coalesce(s.matched,false)=false),
    l.balance_after, e.first_balance, l.received_at
  from s join latest l on l.receiver_number=s.receiver_number
  left join earliest e on e.receiver_number=s.receiver_number
  group by s.receiver_number,l.device_name,l.merchant_name,l.balance_after,e.first_balance,l.received_at
  order by count(*) desc
$$;

revoke all on function public.panel_wallet_sms_report_range(date,date) from public, anon, authenticated;
grant execute on function public.panel_wallet_sms_report_range(date,date) to service_role;
