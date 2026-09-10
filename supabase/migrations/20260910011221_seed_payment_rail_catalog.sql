-- Reporting/configuration catalog for Egyptian payment rails. New external
-- providers are deliberately inactive until their signed API/webhook
-- credentials are configured; this prevents an unconfigured execution path.
alter table public.payment_methods
  drop constraint if exists payment_methods_channel_type_check;

alter table public.payment_methods
  add constraint payment_methods_channel_type_check
  check (channel_type in ('sms_device', 'bank_transfer', 'crypto', 'card', 'cash_network', 'digital_account'));

insert into public.payment_methods (method_code, method_name, channel_type, is_active, sort_order) values
  ('ORANGE_CASH',  'Orange Cash',  'sms_device',     true,  10),
  ('VODAFONE_CASH','Vodafone Cash','sms_device',     true,  20),
  ('WE_PAY',       'WE Pay',       'sms_device',     true,  30),
  ('ETISALAT_CASH','Etisalat Cash','sms_device',     true,  40),
  ('INSTAPAY',     'InstaPay',     'bank_transfer',  true,  50),
  ('FAWRY_PAY',    'Fawry Pay',    'cash_network',   false, 60),
  ('FAWRY_CASH',   'Fawry Cash',   'cash_network',   false, 70),
  ('AXIS_PAY',     'Axis Pay',     'digital_account',false, 80),
  ('MEEZA',        'Meeza',        'card',            false, 90),
  ('TELDA',        'Telda',        'card',            false, 100)
on conflict (method_code) do update set
  method_name = excluded.method_name,
  channel_type = excluded.channel_type,
  sort_order = excluded.sort_order;
