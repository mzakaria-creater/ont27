create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(), phone text not null unique,
  contact_name text, status text not null default 'open' check (status in ('open','closed')),
  assigned_to uuid references public.panel_users(id) on delete set null,
  linked_tx_ref text, last_message_at timestamptz not null default now(), unread_count integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')), body text not null, message_type text not null default 'text',
  status text not null default 'received', wa_message_id text unique, created_at timestamptz not null default now()
);
create index if not exists whatsapp_conversations_last_message_idx on public.whatsapp_conversations(last_message_at desc);
create index if not exists whatsapp_messages_conversation_idx on public.whatsapp_messages(conversation_id, created_at);
alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;
revoke all on public.whatsapp_conversations from anon, authenticated;
revoke all on public.whatsapp_messages from anon, authenticated;
grant select, insert, update, delete on public.whatsapp_conversations to service_role;
grant select, insert, update, delete on public.whatsapp_messages to service_role;

insert into public.role_page_permissions (role_key, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export)
select r.role_key, 'whatsapp', true, true, true, false, false, false
from public.app_roles r
where r.role_key in ('owner', 'admin', 'super_admin', 'operations_admin', 'operator', 'agent_manager')
on conflict (role_key, page_key) do update set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit;
