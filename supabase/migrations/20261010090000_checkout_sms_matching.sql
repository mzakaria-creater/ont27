-- Lets a dedicated matcher (server/checkoutSmsMatcher.ts) claim an inbound
-- SMS for a checkout_sessions row, the same way maven_transaction_id /
-- matched_transaction_id / consumed_by_tx_id already mark an SMS as used by
-- the Maven matcher (server/smsMatcher.ts) -- a separate column because
-- maven_transactions.tx_id is Maven's own external ID (bigint, no local
-- generator); checkout_sessions.id is a local uuid, a different lineage
-- that must never be written into those Maven-specific columns.
alter table inbound_sms add column if not exists claimed_by_checkout_session_id uuid references checkout_sessions(id);
create index if not exists inbound_sms_claimed_by_checkout_session_idx on inbound_sms(claimed_by_checkout_session_id);
