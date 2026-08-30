drop policy if exists sel_wrongful_decline_realtime on public.telegram_alerts;
create policy sel_wrongful_decline_realtime
  on public.telegram_alerts
  for select
  to authenticated
  using (alert_type = 'wrongful_auto_decline');
