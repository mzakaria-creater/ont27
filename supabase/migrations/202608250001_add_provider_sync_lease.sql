-- Cross-instance lease for provider sync. Vercel lambdas do not share memory,
-- so an in-process throttle alone allows every warm instance to run the same
-- expensive pull/matcher concurrently.
create table if not exists public.provider_sync_leases (
  lease_name text primary key,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.provider_sync_leases enable row level security;

create or replace function public.claim_provider_sync_lease(
  p_lease_name text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_rows integer := 0;
begin
  if p_lease_name is null or length(p_lease_name) > 80
     or p_ttl_seconds not between 5 and 300 then
    raise exception 'invalid_sync_lease';
  end if;

  insert into public.provider_sync_leases (lease_name, locked_until, updated_at)
  values (p_lease_name, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (lease_name) do update
    set locked_until = excluded.locked_until,
        updated_at = excluded.updated_at
    where provider_sync_leases.locked_until <= now();

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;

revoke all on table public.provider_sync_leases from public, anon, authenticated;
revoke all on function public.claim_provider_sync_lease(text, integer) from public, anon, authenticated;
grant execute on function public.claim_provider_sync_lease(text, integer) to service_role;
