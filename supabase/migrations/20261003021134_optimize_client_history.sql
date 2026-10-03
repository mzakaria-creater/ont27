-- The transactions screen needs history for the distinct phone numbers on the
-- current page.  Fetching that history with one suffix-ILIKE OR per phone made
-- PostgREST return thousands of rows and held several database connections for
-- seconds at a time.  Normalize to the same last-10-digit key used by the app,
-- index that expression, and aggregate the history in Postgres instead.

create index if not exists idx_maven_transactions_sender_phone_key
  on public.maven_transactions (
    right(regexp_replace(coalesce(sender_number, ''), '[^0-9]', '', 'g'), 10)
  );

create index if not exists idx_maven_payout_transactions_mobile_phone_key
  on public.maven_payout_transactions (
    right(regexp_replace(coalesce(mobile_no, ''), '[^0-9]', '', 'g'), 10)
  );

create or replace function public.panel_client_history(
  p_deposit_phones text[] default array[]::text[],
  p_payout_phones text[] default array[]::text[]
)
returns table (
  phone text,
  deposit_count bigint,
  payout_count bigint,
  approved_at timestamptz[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with deposit_stats as (
    select
      right(regexp_replace(coalesce(mt.sender_number, ''), '[^0-9]', '', 'g'), 10) as phone,
      count(*)::bigint as deposit_count,
      array_agg(mt.first_seen_at order by mt.first_seen_at)
        filter (where upper(coalesce(mt.status, '')) in ('PAID', 'APPROVED')) as approved_at
    from public.maven_transactions mt
    where right(regexp_replace(coalesce(mt.sender_number, ''), '[^0-9]', '', 'g'), 10)
      = any(coalesce(p_deposit_phones, array[]::text[]))
    group by 1
  ),
  payout_stats as (
    select
      right(regexp_replace(coalesce(pt.mobile_no, ''), '[^0-9]', '', 'g'), 10) as phone,
      count(*)::bigint as payout_count
    from public.maven_payout_transactions pt
    where right(regexp_replace(coalesce(pt.mobile_no, ''), '[^0-9]', '', 'g'), 10)
      = any(coalesce(p_payout_phones, array[]::text[]))
    group by 1
  )
  select
    coalesce(d.phone, p.phone) as phone,
    coalesce(d.deposit_count, 0)::bigint as deposit_count,
    coalesce(p.payout_count, 0)::bigint as payout_count,
    coalesce(d.approved_at, array[]::timestamptz[]) as approved_at
  from deposit_stats d
  full join payout_stats p using (phone);
$$;

revoke execute on function public.panel_client_history(text[], text[]) from public, anon, authenticated;
grant execute on function public.panel_client_history(text[], text[]) to service_role;
