-- Keep manual and device SMS inserts from colliding with mirrored legacy ids.
select setval(
  pg_get_serial_sequence('public.inbound_sms', 'id'),
  coalesce((select max(id) from public.inbound_sms), 1),
  true
);
