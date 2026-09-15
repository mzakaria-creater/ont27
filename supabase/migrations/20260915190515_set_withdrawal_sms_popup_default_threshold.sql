alter table public.automation_settings
  alter column high_value_sms_popup_threshold set default 5000;

-- Move the original default to 5,000 without overwriting a threshold an
-- operator has already customized through the Automation settings page.
update public.automation_settings
set high_value_sms_popup_threshold = 5000
where id = 1 and high_value_sms_popup_threshold = 10000;
