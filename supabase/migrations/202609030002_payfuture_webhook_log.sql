create table if not exists public.payfuture_webhook_log (
  id uuid primary key default gen_random_uuid(), received_at timestamptz not null default now(),
  request_id text, signature_valid boolean not null default false, status_code int,
  event_reference text, error text, payload jsonb not null default '{}'::jsonb
);
create index if not exists payfuture_webhook_log_received_idx on public.payfuture_webhook_log(received_at desc);
alter table public.payfuture_webhook_log enable row level security;
revoke all on public.payfuture_webhook_log from anon, authenticated;
create policy service_role_full_access_payfuture_webhook_log on public.payfuture_webhook_log for all to service_role using (true) with check (true);
