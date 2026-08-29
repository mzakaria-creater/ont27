alter table public.panel_users
  add column if not exists account_status text not null default 'active'
    check (account_status in ('active','inactive','frozen','rejected')),
  add column if not exists frozen_until timestamptz,
  add column if not exists status_reason text,
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_changed_by text;

create table public.panel_user_action_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.panel_users(id) on delete cascade,
  purpose text not null check (purpose in ('magic_login','password_reset')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  issued_by text,
  created_at timestamptz not null default now()
);
create index panel_user_action_tokens_lookup_idx
  on public.panel_user_action_tokens(token_hash,purpose,expires_at)
  where used_at is null and revoked_at is null;
alter table public.panel_user_action_tokens enable row level security;
revoke all on public.panel_user_action_tokens from anon,authenticated;
grant all on public.panel_user_action_tokens to service_role;
