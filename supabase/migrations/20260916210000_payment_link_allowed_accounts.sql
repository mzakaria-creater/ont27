-- Lets an operator pin a link to a specific set of receiving accounts
-- (exact wallets/InstaPay/bank accounts), instead of only a broad payment
-- method type. Deliberately its own array column rather than reusing
-- payment_pools: an account's payment_pool_id is a single shared FK, and
-- repointing it per-link would risk pulling that account out of whatever
-- pool another merchant already depends on.
alter table public.payment_links
  add column if not exists allowed_account_ids uuid[] not null default '{}';
