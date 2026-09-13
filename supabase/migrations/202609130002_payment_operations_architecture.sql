-- Gateway/payment architecture: separate lifecycle dimensions and an
-- append-only operation/log trail. Secrets are never intended for storage in
-- these tables; the API sanitizer removes common credential/card fields.

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  merchant_id uuid references public.merchants(id) on delete set null,
  master_merchant_id uuid references public.master_merchants(id) on delete set null,
  sub_merchant_id bigint references public.merchants_hierarchy(id) on delete set null,
  checkout_session_id uuid references public.checkout_sessions(id) on delete set null,
  maven_tx_id bigint,
  amount numeric not null check (amount > 0),
  currency text not null default 'EGP',
  payment_method text,
  gateway_status text not null default 'created',
  transaction_status text not null default 'pending',
  business_status text not null default 'unpaid',
  settlement_status text not null default 'unsettled',
  reconciliation_status text not null default 'unreconciled',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transaction_operations (
  id uuid primary key default gen_random_uuid(),
  payment_transaction_id uuid not null references public.payment_transactions(id) on delete cascade,
  operation_type text not null check (operation_type in ('create','capture','refund','payout','void','query')),
  idempotency_key text not null,
  status text not null default 'started' check (status in ('started','succeeded','failed','pending')),
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(payment_transaction_id, operation_type, idempotency_key)
);

create table if not exists public.gateway_logs (
  id uuid primary key default gen_random_uuid(),
  payment_transaction_id uuid references public.payment_transactions(id) on delete set null,
  transaction_operation_id uuid references public.transaction_operations(id) on delete set null,
  provider text not null,
  operation text not null,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  request_headers jsonb not null default '{}'::jsonb,
  http_status integer,
  duration_ms integer,
  success boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  idempotency_key text not null,
  operation text not null,
  payment_transaction_id uuid references public.payment_transactions(id) on delete set null,
  response_status integer,
  response_payload jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  unique(scope, idempotency_key, operation)
);

create index if not exists payment_transactions_status_idx on public.payment_transactions(transaction_status, created_at desc);
create index if not exists payment_transactions_merchant_idx on public.payment_transactions(merchant_id, created_at desc);
create index if not exists transaction_operations_tx_idx on public.transaction_operations(payment_transaction_id, created_at desc);
create index if not exists gateway_logs_tx_idx on public.gateway_logs(payment_transaction_id, created_at desc);

alter table public.payment_transactions enable row level security;
alter table public.transaction_operations enable row level security;
alter table public.gateway_logs enable row level security;
alter table public.payment_idempotency_keys enable row level security;

drop policy if exists service_role_payment_transactions on public.payment_transactions;
create policy service_role_payment_transactions on public.payment_transactions for all to service_role using (true) with check (true);
drop policy if exists service_role_transaction_operations on public.transaction_operations;
create policy service_role_transaction_operations on public.transaction_operations for all to service_role using (true) with check (true);
drop policy if exists service_role_gateway_logs on public.gateway_logs;
create policy service_role_gateway_logs on public.gateway_logs for all to service_role using (true) with check (true);
drop policy if exists service_role_payment_idempotency on public.payment_idempotency_keys;
create policy service_role_payment_idempotency on public.payment_idempotency_keys for all to service_role using (true) with check (true);
