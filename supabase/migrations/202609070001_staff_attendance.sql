create table if not exists public.staff_attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.panel_users(id) on delete cascade,
  wallet_number text,
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  constraint staff_attendance_checkout_after_checkin check (checked_out_at is null or checked_out_at >= checked_in_at)
);
create index if not exists staff_attendance_user_time_idx on public.staff_attendance_sessions(user_id, checked_in_at desc);
create index if not exists staff_attendance_wallet_time_idx on public.staff_attendance_sessions(wallet_number, checked_in_at desc);
alter table public.staff_attendance_sessions enable row level security;
revoke all on public.staff_attendance_sessions from anon, authenticated;
grant all on public.staff_attendance_sessions to service_role;
