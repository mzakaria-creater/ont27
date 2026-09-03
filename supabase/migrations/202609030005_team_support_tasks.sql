alter table public.support_tickets add column if not exists action_requested text;
alter table public.support_tickets add column if not exists due_at timestamptz;
alter table public.support_tickets add column if not exists task_type text default 'support';
create index if not exists support_tickets_due_idx on public.support_tickets(due_at, ticket_status);
