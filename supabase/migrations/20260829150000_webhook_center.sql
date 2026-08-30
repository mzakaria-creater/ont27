create table if not exists public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  direction text not null check (direction in ('inbound','outbound')),
  merchant_id uuid references public.merchants(id) on delete set null,
  url text,
  event_types text[] not null default '{}',
  signing_secret text not null,
  inbound_token_hash text unique,
  is_active boolean not null default true,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_direction_target check (
    (direction = 'outbound' and url is not null and inbound_token_hash is null)
    or (direction = 'inbound' and url is null and inbound_token_hash is not null)
  )
);

create table if not exists public.webhook_delivery_log (
  id bigint generated always as identity primary key,
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  event_type text,
  status_code integer,
  success boolean not null default false,
  latency_ms integer,
  request_id text,
  error text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists webhook_delivery_log_endpoint_created_idx on public.webhook_delivery_log(endpoint_id, created_at desc);
create index if not exists webhook_delivery_log_created_idx on public.webhook_delivery_log(created_at desc);

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_delivery_log enable row level security;
revoke all on public.webhook_endpoints from anon, authenticated;
revoke all on public.webhook_delivery_log from anon, authenticated;

insert into public.role_page_permissions(role_key,page_key,can_view,can_create,can_edit,can_delete,can_approve,can_export)
values
 ('super_admin','webhooks',true,true,true,true,true,true),
 ('owner','webhooks',true,true,true,true,false,true),
 ('admin','webhooks',true,true,true,true,false,true),
 ('operations_admin','webhooks',true,false,false,false,false,true)
on conflict(role_key,page_key) do update set
 can_view=excluded.can_view, can_create=excluded.can_create, can_edit=excluded.can_edit,
 can_delete=excluded.can_delete, can_approve=excluded.can_approve, can_export=excluded.can_export;
