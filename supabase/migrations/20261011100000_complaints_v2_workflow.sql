-- Complete the V2 complaints workflow without changing existing complaint IDs
-- or the provider transaction decision path.
alter table public.complaints
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists sms_received boolean not null default false,
  add column if not exists sms_id bigint,
  add column if not exists balance_after numeric,
  add column if not exists finding text,
  add column if not exists priority text not null default 'normal',
  add column if not exists state text not null default 'open',
  add column if not exists ticket_id bigint,
  add column if not exists resolved_action text,
  add column if not exists resolved_by text,
  add column if not exists resolved_at timestamptz;

alter table public.complaints
  drop constraint if exists complaints_priority_check,
  add constraint complaints_priority_check check (priority in ('high', 'medium', 'normal')),
  drop constraint if exists complaints_state_check,
  add constraint complaints_state_check check (state in ('open', 'closed'));

alter table public.support_tickets
  add column if not exists messages jsonb not null default '[]'::jsonb,
  add column if not exists notes jsonb not null default '[]'::jsonb,
  add column if not exists telegram_status text;

create index if not exists complaints_state_created_idx on public.complaints(state, created_at desc);
create index if not exists complaints_status_created_idx on public.complaints(status, created_at desc);
create index if not exists complaints_tx_idx on public.complaints(tx_id);
create index if not exists complaints_ticket_idx on public.complaints(ticket_id);
create index if not exists complaints_phone_idx on public.complaints(customer_phone);

do $$
begin
  if to_regclass('public.complaints') is not null
     and not exists (
       select 1 from pg_policies
       where schemaname = 'public' and tablename = 'complaints'
         and policyname = 'complaints_service_role_access'
     ) then
    create policy complaints_service_role_access on public.complaints
      for all to service_role using (true) with check (true);
  end if;
  if to_regclass('public.support_tickets') is not null
     and not exists (
       select 1 from pg_policies
       where schemaname = 'public' and tablename = 'support_tickets'
         and policyname = 'support_tickets_service_role_access'
     ) then
    create policy support_tickets_service_role_access on public.support_tickets
      for all to service_role using (true) with check (true);
  end if;
end $$;
