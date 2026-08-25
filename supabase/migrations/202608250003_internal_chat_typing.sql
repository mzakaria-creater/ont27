alter table public.internal_chat_presence add column if not exists typing_room_id uuid references public.internal_chat_rooms(id) on delete set null;
alter table public.internal_chat_presence add column if not exists typing_at timestamptz;

