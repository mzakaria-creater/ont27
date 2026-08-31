alter table public.inbound_sms
  add column if not exists is_blocked boolean not null default false,
  add column if not exists block_reason text,
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_by text;

create index if not exists inbound_sms_unlinked_block_idx
  on public.inbound_sms (is_blocked, received_at desc)
  where consumed_by_tx_id is null and matched_transaction_id is null and maven_transaction_id is null;
