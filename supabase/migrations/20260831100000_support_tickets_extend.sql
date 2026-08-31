-- Existing deployments already have support_tickets; extend it safely.
alter table public.support_tickets add column if not exists ticket_no text;
alter table public.support_tickets add column if not exists customer_name text;
alter table public.support_tickets add column if not exists subject text;
alter table public.support_tickets add column if not exists description text;
alter table public.support_tickets add column if not exists priority text default 'normal';
alter table public.support_tickets add column if not exists assigned_to text;
alter table public.support_tickets add column if not exists resolved_at timestamptz;
update public.support_tickets set ticket_no = 'TKT-' || id where ticket_no is null;
create unique index if not exists support_tickets_ticket_no_idx on public.support_tickets(ticket_no);
create index if not exists support_tickets_status_idx on public.support_tickets(ticket_status, created_at desc);
create index if not exists support_tickets_tx_idx on public.support_tickets(tx_id);
