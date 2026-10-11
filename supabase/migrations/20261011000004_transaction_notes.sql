create table if not exists public.transaction_notes (
  id bigint generated always as identity primary key,
  tx_id bigint not null,
  author text not null,
  note text not null check (char_length(note) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists transaction_notes_tx_idx on public.transaction_notes (tx_id, created_at desc);
alter table public.transaction_notes enable row level security;
