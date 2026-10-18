-- Keep the SMS webhook acknowledgement fast. These two triggers ran broad
-- matching/decision scans inside the INSERT transaction even though the same
-- work is already covered by the minute-by-minute V2 cron jobs.
drop trigger if exists inbound_sms_auto_match on public.inbound_sms;
drop trigger if exists trg_recheck_pending_sms on public.inbound_sms;

-- The webhook checks transaction references before inserting a duplicate.
create index if not exists inbound_sms_trx_id_btree_idx
  on public.inbound_sms (trx_id)
  where trx_id is not null;

-- Keeps the scheduled wallet/SMS matcher focused on recent, usable deposits.
create index if not exists inbound_sms_match_sweep_fast_idx
  on public.inbound_sms (sms_category, amount, received_at desc)
  where consumed_by_tx_id is null
    and matched_transaction_id is null
    and coalesce(is_blocked, false) = false
    and coalesce(is_duplicate, false) = false;
