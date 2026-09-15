alter table public.automation_settings
  add column if not exists high_value_sms_popup_threshold numeric not null default 10000;

comment on column public.automation_settings.high_value_sms_popup_threshold is
  'Minimum SMS amount in EGP that must be exceeded before the global high-value alert popup opens.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automation_settings'::regclass
      and conname = 'automation_settings_high_value_sms_popup_threshold_check'
  ) then
    alter table public.automation_settings
      add constraint automation_settings_high_value_sms_popup_threshold_check
      check (high_value_sms_popup_threshold between 0 and 10000000);
  end if;
end
$$;
