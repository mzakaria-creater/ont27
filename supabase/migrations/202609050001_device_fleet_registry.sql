create table if not exists public.device_registry (
  device text primary key check (device ~ '^ont(1|2|3|4|5|6|7|8|9|10)$'),
  label text,
  sim_number text,
  sim_provider text,
  sms_webhook text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.device_registry enable row level security;
drop policy if exists device_registry_service_role on public.device_registry;
create policy device_registry_service_role on public.device_registry for all to service_role using (true) with check (true);

insert into public.device_registry (device, label, active)
select 'ont' || n, 'ONT' || n, true from generate_series(1, 10) n
on conflict (device) do nothing;

create index if not exists ix_device_registry_active on public.device_registry(active, device);
