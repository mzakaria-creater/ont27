drop policy if exists sel_support_complaint_realtime on public.telegram_alerts;

create policy sel_support_complaint_realtime
  on public.telegram_alerts
  for select
  to authenticated
  using (
    alert_type = 'complaint_filed'
    and coalesce((select auth.jwt()) -> 'app_metadata' ->> 'app_role', '')
      in ('owner', 'admin', 'super_admin', 'operator', 'operations_admin')
  );
