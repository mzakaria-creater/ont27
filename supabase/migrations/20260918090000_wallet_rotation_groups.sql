-- Wallet rotation groups: a display-only priority rotation aid.
--
-- enrich_priority (on wallet_device_map) only feeds the read-only
-- /api/wallets/allocation/simulate view. It never changes which wallet
-- Maven actually routes customer funds to — Maven has not exposed an API
-- for that yet. This table lets operators group 2+ wallets and rotate
-- their simulated priority on a timer or after receiving a set amount;
-- the /api/cron/wallet-rotation job (every 5 minutes) advances it.
create table if not exists wallet_rotation_groups (
  id uuid primary key default gen_random_uuid(),
  wallet_numbers text[] not null,
  mode text not null check (mode in ('time', 'amount')),
  interval_minutes integer,
  amount_threshold numeric,
  current_index integer not null default 0,
  last_rotated_at timestamptz,
  amount_received_since_rotation numeric not null default 0,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallet_rotation_groups_mode_fields check (
    (mode = 'time' and interval_minutes is not null and interval_minutes > 0)
    or (mode = 'amount' and amount_threshold is not null and amount_threshold > 0)
  )
);
