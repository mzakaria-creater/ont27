-- Gateway API v2 foundation for Supabase.
-- The application API is intentionally thin: lifecycle state and the audit
-- trail remain in Postgres, where they can be queried consistently by the
-- panel, checkout, Railway workers, and reconciliation jobs.

alter table public.payment_transactions
  add column if not exists provider_reference text,
  add column if not exists failure_code text,
  add column if not exists failure_message text,
  add column if not exists paid_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists refunded_amount numeric not null default 0;

alter table public.payment_transactions
  drop constraint if exists payment_transactions_gateway_status_check;
alter table public.payment_transactions
  add constraint payment_transactions_gateway_status_check
  check (gateway_status in ('created','allocated','processing','authorized','captured','failed','cancelled','refunded'));

alter table public.payment_transactions
  drop constraint if exists payment_transactions_transaction_status_check;
alter table public.payment_transactions
  add constraint payment_transactions_transaction_status_check
  check (transaction_status in ('pending','authorized','paid','failed','cancelled','refunded','partially_refunded'));

alter table public.payment_transactions
  drop constraint if exists payment_transactions_business_status_check;
alter table public.payment_transactions
  add constraint payment_transactions_business_status_check
  check (business_status in ('unpaid','paid','partially_refunded','refunded','cancelled'));

alter table public.payment_transactions
  drop constraint if exists payment_transactions_settlement_status_check;
alter table public.payment_transactions
  add constraint payment_transactions_settlement_status_check
  check (settlement_status in ('unsettled','pending','settled','partially_settled','disputed'));

alter table public.payment_transactions
  drop constraint if exists payment_transactions_reconciliation_status_check;
alter table public.payment_transactions
  add constraint payment_transactions_reconciliation_status_check
  check (reconciliation_status in ('unreconciled','matched','mismatched','manual_review'));

create index if not exists payment_transactions_public_id_idx
  on public.payment_transactions(public_id);
create unique index if not exists transaction_operations_idempotency_idx
  on public.transaction_operations(payment_transaction_id, operation_type, idempotency_key);
create index if not exists payment_idempotency_expires_idx
  on public.payment_idempotency_keys(expires_at);

create or replace function public.gateway_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists payment_transactions_touch_updated_at on public.payment_transactions;
create trigger payment_transactions_touch_updated_at
before update on public.payment_transactions
for each row execute function public.gateway_touch_updated_at();

-- A stable read model for the external Gateway API. It intentionally contains
-- no request payloads, credentials, card data, or raw webhook bodies.
create or replace view public.v_gateway_payment_summary as
select
  p.id,
  p.public_id,
  p.merchant_id,
  p.master_merchant_id,
  p.sub_merchant_id,
  p.checkout_session_id,
  p.provider_reference,
  p.amount,
  p.currency,
  p.payment_method,
  p.gateway_status,
  p.transaction_status,
  p.business_status,
  p.settlement_status,
  p.reconciliation_status,
  p.failure_code,
  p.failure_message,
  p.refunded_amount,
  p.created_at,
  p.updated_at,
  p.paid_at,
  p.cancelled_at,
  coalesce(op.operation_count, 0) as operation_count,
  op.last_operation_at
from public.payment_transactions p
left join lateral (
  select count(*)::integer as operation_count, max(created_at) as last_operation_at
  from public.transaction_operations o
  where o.payment_transaction_id = p.id
) op on true;

-- Safe, idempotent create primitive. It is callable by the server-side API
-- using the secret client; no anon/authenticated grants are added here.
create or replace function public.gateway_create_payment(
  p_public_id text,
  p_merchant_id uuid,
  p_master_merchant_id uuid,
  p_sub_merchant_id bigint,
  p_checkout_session_id uuid,
  p_amount numeric,
  p_currency text,
  p_payment_method text,
  p_provider text,
  p_idempotency_key text,
  p_request_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing jsonb;
  payment_row public.payment_transactions%rowtype;
  operation_row public.transaction_operations%rowtype;
begin
  if nullif(trim(p_public_id), '') is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'invalid payment';
  end if;
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception using errcode = '22023', message = 'idempotency key required';
  end if;

  select jsonb_build_object('payment_id', i.payment_transaction_id,
                            'response_status', i.response_status,
                            'response_payload', i.response_payload)
    into existing
  from public.payment_idempotency_keys i
  where i.scope = p_merchant_id::text
    and i.operation = 'create'
    and i.idempotency_key = p_idempotency_key
    and i.expires_at > now()
  for update;
  if existing is not null then return existing; end if;

  insert into public.payment_transactions(
    public_id, merchant_id, master_merchant_id, sub_merchant_id,
    checkout_session_id, amount, currency, payment_method,
    gateway_status, transaction_status, business_status,
    settlement_status, reconciliation_status, metadata
  ) values (
    p_public_id, p_merchant_id, p_master_merchant_id, p_sub_merchant_id,
    p_checkout_session_id, p_amount, upper(coalesce(p_currency, 'EGP')),
    p_payment_method, 'created', 'pending', 'unpaid',
    'unsettled', 'unreconciled', jsonb_build_object('provider', p_provider)
  ) returning * into payment_row;

  insert into public.transaction_operations(
    payment_transaction_id, operation_type, idempotency_key, status,
    request_payload, response_payload, completed_at
  ) values (
    payment_row.id, 'create', p_idempotency_key, 'succeeded',
    coalesce(p_request_payload, '{}'::jsonb),
    jsonb_build_object('public_id', payment_row.public_id, 'provider', p_provider), now()
  ) returning * into operation_row;

  insert into public.gateway_logs(
    payment_transaction_id, transaction_operation_id, provider, operation,
    request_payload, response_payload, success
  ) values (
    payment_row.id, operation_row.id, coalesce(p_provider, 'unknown'), 'create',
    coalesce(p_request_payload, '{}'::jsonb),
    jsonb_build_object('public_id', payment_row.public_id, 'status', 'pending'), true
  );

  insert into public.payment_idempotency_keys(
    scope, idempotency_key, operation, payment_transaction_id,
    response_status, response_payload
  ) values (
    p_merchant_id::text, p_idempotency_key, 'create', payment_row.id, 201,
    jsonb_build_object('payment', to_jsonb(payment_row))
  );

  return jsonb_build_object('payment_id', payment_row.id, 'response_status', 201,
                            'response_payload', jsonb_build_object('payment', to_jsonb(payment_row)));
end;
$$;

revoke all on function public.gateway_create_payment(text, uuid, uuid, bigint, uuid, numeric, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.gateway_create_payment(text, uuid, uuid, bigint, uuid, numeric, text, text, text, text, jsonb) to service_role;

revoke all on public.v_gateway_payment_summary from anon, authenticated;
grant select on public.v_gateway_payment_summary to service_role;
