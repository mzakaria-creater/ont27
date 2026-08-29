create table public.access_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.access_team_members (
  team_id uuid not null references public.access_teams(id) on delete cascade,
  user_id uuid not null references public.panel_users(id) on delete cascade,
  is_lead boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(team_id,user_id)
);

create table public.user_access_scopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.panel_users(id) on delete cascade,
  scope_type text not null check (scope_type in ('country','payment_method','merchant','deposit_type','team')),
  scope_value text not null,
  access_level text not null default 'view' check (access_level in ('view','edit','approve')),
  granted_by text,
  created_at timestamptz not null default now(),
  unique(user_id,scope_type,scope_value,access_level)
);

create index user_access_scopes_user_type_idx on public.user_access_scopes(user_id,scope_type);
create index access_team_members_user_idx on public.access_team_members(user_id);

alter table public.access_teams enable row level security;
alter table public.access_team_members enable row level security;
alter table public.user_access_scopes enable row level security;
revoke all on public.access_teams,public.access_team_members,public.user_access_scopes from anon,authenticated;
grant all on public.access_teams,public.access_team_members,public.user_access_scopes to service_role;
