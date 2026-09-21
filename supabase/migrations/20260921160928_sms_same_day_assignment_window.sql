-- Keep SMS-to-transaction assignment on the same Cairo calendar day.
-- Messages older than three hours require an explicit unblock before a
-- human can link them, preserving the existing block/unblock audit flow.
alter table public.inbound_sms
  add column if not exists assignment_unlocked_at timestamptz,
  add column if not exists assignment_unlocked_by text;

create index if not exists inbound_sms_assignment_window_idx
  on public.inbound_sms (received_at, is_blocked, consumed_by_tx_id);
