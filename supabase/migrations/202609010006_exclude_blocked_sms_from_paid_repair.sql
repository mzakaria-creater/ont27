-- The paid-transaction repair sweep is another assignment path; blocked SMS
-- must be invisible to it as well.
create or replace function public.link_wallet_sms_to_paid_transactions(p_window_minutes integer default 15)
returns jsonb language plpgsql security definer set search_path=public,pg_temp set "TimeZone"='UTC' as $$
declare v_linked integer := 0;
begin
 with paid as (
   select m.tx_id,m.amount,regexp_replace(coalesce(m.receiving_wallet,m.to_account_number,''),'\D','','g') wallet,
          coalesce(case when m.created_utc ~ '^\d{4}-\d{2}-\d{2}' then m.created_utc::timestamptz end,m.first_seen_at,m.last_status_change) paid_time
   from public.maven_transactions m where upper(m.status)='PAID' and m.amount is not null and coalesce(m.receiving_wallet,m.to_account_number) is not null
     and not exists(select 1 from public.inbound_sms z where z.consumed_by_tx_id=m.tx_id)
 ), sms as (
   select s.id,s.amount,regexp_replace(coalesce(s.confirmed_wallet_number,s.receiver_number,(select h.wallet_number from public.wallet_device_history h where h.device=coalesce(s.webhook_name,s.device_name) and h.changed_at<=s.received_at order by h.changed_at desc limit 1),''),'\D','','g') wallet,s.received_at,s.webhook_name
   from public.inbound_sms s where s.sms_category='deposit' and s.amount is not null and s.received_at is not null and s.consumed_by_tx_id is null
     and not coalesce(s.is_blocked,false) and coalesce(s.is_duplicate,false)=false
 ), cand as (
   select p.tx_id,s.id sms_id,p.amount mv_amount,s.amount sms_amount,p.wallet,p.paid_time,s.received_at,s.webhook_name,
     abs(extract(epoch from(s.received_at-p.paid_time))) sec_diff,
     row_number() over(partition by p.tx_id order by abs(extract(epoch from(s.received_at-p.paid_time))),s.id) tx_rank,count(*) over(partition by p.tx_id) tx_candidates,
     row_number() over(partition by s.id order by abs(extract(epoch from(s.received_at-p.paid_time))),p.tx_id) sms_rank,count(*) over(partition by s.id) sms_candidates
   from paid p join sms s on s.amount=p.amount and p.wallet<>'' and s.wallet<>'' and right(p.wallet,10)=right(s.wallet,10) and p.paid_time is not null and abs(extract(epoch from(s.received_at-p.paid_time)))<=greatest(p_window_minutes,1)*60
 ), chosen as (select * from cand where tx_rank=1 and sms_rank=1 and tx_candidates=1 and sms_candidates=1), ins as (
   insert into public.sms_maven_matches(sms_id,tx_id,receiving_wallet,sms_amount,mv_amount,received_at,mv_time,sec_diff,webhook_name,matched_at)
   select sms_id,tx_id,wallet,sms_amount,mv_amount,received_at,paid_time,sec_diff,webhook_name,now() from chosen
   on conflict(sms_id) do update set tx_id=excluded.tx_id,receiving_wallet=excluded.receiving_wallet,sms_amount=excluded.sms_amount,mv_amount=excluded.mv_amount,received_at=excluded.received_at,mv_time=excluded.mv_time,sec_diff=excluded.sec_diff,webhook_name=excluded.webhook_name,matched_at=now()
   returning sms_id,tx_id
 ) update public.inbound_sms s set consumed_by_tx_id=i.tx_id,matched_transaction_id=i.tx_id,matched=true,match_status='matched_paid',auto_match_score=100,review_required=false,processed_at=coalesce(s.processed_at,now()),notes=concat_ws('; ',nullif(s.notes,''),'linked_to_paid_by_wallet_amount_time') from ins i where s.id=i.sms_id;
 get diagnostics v_linked=row_count; return jsonb_build_object('linked',v_linked,'window_minutes',p_window_minutes);
end;
$$;
