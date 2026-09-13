-- Allow the panel login form to use either the username or the stored email.
-- Keep the helper SECURITY DEFINER because panel_users is server-controlled;
-- callers still receive at most two rows so case-collision handling remains.
create or replace function public.panel_get_user_for_login(p_username text)
returns setof public.panel_users
language sql
security definer
set search_path = public
as $$
  select u.*
  from public.panel_users u
  where lower(u.username) = lower(btrim(p_username))
     or (u.email is not null and lower(u.email) = lower(btrim(p_username)))
  order by u.created_at asc
  limit 2;
$$;

revoke execute on function public.panel_get_user_for_login(text) from public, anon, authenticated;
grant execute on function public.panel_get_user_for_login(text) to service_role;

-- The new payment.created callback is delivered only to configured outbound
-- endpoints. Keep the delivery log server-only as it contains payload metadata.
alter table if exists public.webhook_delivery_log enable row level security;
drop policy if exists service_role_all_webhook_delivery_log on public.webhook_delivery_log;
create policy service_role_all_webhook_delivery_log on public.webhook_delivery_log
  for all to service_role using (true) with check (true);
