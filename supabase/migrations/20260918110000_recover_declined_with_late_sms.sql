-- Recovers transactions that sweep_auto_decline_stale_unmatched declined for
-- "no SMS evidence", when a late-arriving SMS turns out to match after all.
-- Mirrors the old ontarget-egy project's sweep_recover_declined_with_late_sms
-- (verified against its source this session), adapted to this project's
-- schema and made slightly stricter: only ever touches a review_queue row
-- whose decision_reason literally starts with 'No clean match' (the exact
-- string sweep_auto_decline_stale_unmatched writes), requires EXACTLY one
-- unambiguous same-amount/same-wallet/unconsumed SMS within a 30-minute
-- window of the transaction, and — unlike the old function — also removes
-- the auto-blacklist entry that decline sweep added for this exact tx_id,
-- so a wrongly-declined customer isn't left blocked after being recovered.
--
-- Propagates the status change the same way the decline sweep does: an
-- INSERT into browser_jobs, picked up by the same live worker that already
-- executes DECLINED/PAID transitions on Maven.
create or replace function public.recover_declined_with_late_sms(p_lookback_minutes integer default 120)
returns table(recovered_tx_id bigint, note text)
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  v_sms inbound_sms;
  v_cnt int;
begin
  for r in
    select rq.id as review_id, rq.tx_id as r_tx_id, rq.amount as r_amount,
           coalesce(mt.receiving_wallet, mt.to_account_number) as wallet,
           mt.created_utc::timestamptz as tx_time, mt.sender_number
    from review_queue rq
    join maven_transactions mt on mt.tx_id = rq.tx_id
    where rq.source = 'maven' and rq.decision = 'auto_declined'
      and rq.decision_reason ilike 'No clean match%'
      and rq.updated_at > now() - make_interval(mins => p_lookback_minutes)
      and mt.status = 'DECLINED'
  loop
    select count(*) into v_cnt from inbound_sms s
    where s.sms_category = 'deposit' and s.amount is not null and abs(s.amount - r.r_amount) < 0.01
      and s.consumed_by_tx_id is null and coalesce(s.is_blocked, false) = false
      and r.wallet is not null and s.receiver_number is not null
      and right(regexp_replace(s.receiver_number, '\D', '', 'g'), 10) = right(regexp_replace(r.wallet, '\D', '', 'g'), 10)
      and s.received_at between r.tx_time - interval '30 minutes' and r.tx_time + interval '30 minutes';

    if v_cnt = 1 then
      select s.* into v_sms from inbound_sms s
      where s.sms_category = 'deposit' and s.amount is not null and abs(s.amount - r.r_amount) < 0.01
        and s.consumed_by_tx_id is null and coalesce(s.is_blocked, false) = false
        and r.wallet is not null and s.receiver_number is not null
        and right(regexp_replace(s.receiver_number, '\D', '', 'g'), 10) = right(regexp_replace(r.wallet, '\D', '', 'g'), 10)
        and s.received_at between r.tx_time - interval '30 minutes' and r.tx_time + interval '30 minutes'
      limit 1;

      update inbound_sms set consumed_by_tx_id = r.r_tx_id where id = v_sms.id and consumed_by_tx_id is null;
      get diagnostics v_cnt = row_count;
      if v_cnt = 1 then
        update review_queue set
          decision = 'recovered_sms_confirmed',
          decision_reason = format('Recovered: late SMS #%s (%s) matched this wallet — was wrongly declined', v_sms.id, v_sms.amount),
          matched_sms_id = v_sms.id, target_status = 'PAID', decided_by = 'system_recovery', decided_at = now(), updated_at = now()
        where id = r.review_id;

        update maven_transactions set status = 'PAID' where tx_id = r.r_tx_id;

        insert into browser_jobs (tx_id, amount, target_status, source, state)
        values (r.r_tx_id, r.r_amount, 'PAID', 'auto_engine', 'pending')
        on conflict (tx_id, target_status) where state in ('pending', 'running') do nothing;

        if r.sender_number is not null then
          delete from api_risk_blacklist
          where type = 'phone'
            and regexp_replace(value, '\D', '', 'g') = regexp_replace(r.sender_number, '\D', '', 'g')
            and reason = format('Auto-declined transaction %s with no SMS evidence', r.r_tx_id);
        end if;

        recovered_tx_id := r.r_tx_id; note := format('recovered via sms #%s', v_sms.id); return next;
      end if;
    end if;
  end loop;
end;
$function$;
