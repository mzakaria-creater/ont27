-- Native SMS intake auth for the new project.
-- Secrets are stored as SHA-256 hashes; raw device keys are issued once by
-- the provisioning process and must never be committed to this repository.
create table if not exists public.device_keys (
  device text primary key check (device ~ '^ont[1-9][0-9]*$'),
  key_hash text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.device_keys enable row level security;
revoke all on public.device_keys from anon, authenticated;

create table if not exists public.sms_intake_auth_log (
  device text primary key,
  auth_mode text,
  last_seen_at timestamptz not null default now(),
  hits_legacy bigint not null default 0,
  hits_device_key bigint not null default 0
);
alter table public.sms_intake_auth_log enable row level security;
revoke all on public.sms_intake_auth_log from anon, authenticated;

create or replace function public.log_sms_intake_auth(p_device text, p_mode text)
returns void language plpgsql security definer set search_path=public as $$
begin
  insert into public.sms_intake_auth_log as l
    (device, auth_mode, last_seen_at, hits_legacy, hits_device_key)
  values (p_device, p_mode, now(),
    case when p_mode = 'legacy_shared' then 1 else 0 end,
    case when p_mode = 'device_key' then 1 else 0 end)
  on conflict (device) do update set
    auth_mode = excluded.auth_mode,
    last_seen_at = now(),
    hits_legacy = l.hits_legacy + case when p_mode = 'legacy_shared' then 1 else 0 end,
    hits_device_key = l.hits_device_key + case when p_mode = 'device_key' then 1 else 0 end;
end $$;
revoke all on function public.log_sms_intake_auth(text,text) from public, anon, authenticated;
grant execute on function public.log_sms_intake_auth(text,text) to service_role;
