-- Public "payout master link" system, mirroring payment_links' security
-- model exactly (short_code + checkout_token_hash, rotated on every share)
-- but for money going OUT instead of in.
--
-- Client submissions never touch the existing payout_requests table
-- directly — that table triggers real device automation (a physical phone
-- executing a USSD transfer) the moment an operator approves it. A public,
-- unauthenticated form writing straight into that pipeline would be a real
-- attack surface. Instead, submissions land in payout_link_requests as
-- 'pending' and sit inert until an authenticated operator reviews one and
-- explicitly converts it into a real payout_requests row through the
-- existing, unchanged /api/payout-requests flow — same human-approval
-- backstop that already protects every other payout.

create table if not exists public.payout_links (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references public.merchants(id) on delete set null,
  short_code text not null unique,
  checkout_token_hash text,
  title text,
  client_name text,
  currency text not null default 'EGP',
  amount_mode text not null default 'open' check (amount_mode in ('open', 'fixed')),
  amount numeric,
  min_amount numeric,
  max_amount numeric,
  active boolean not null default true,
  expires_at timestamptz,
  max_uses integer,
  use_count integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payout_links_short_code_idx on public.payout_links (short_code);
create index if not exists payout_links_token_hash_idx on public.payout_links (checkout_token_hash);

create table if not exists public.payout_link_requests (
  id uuid primary key default gen_random_uuid(),
  payout_link_id uuid not null references public.payout_links(id) on delete cascade,
  reference text not null unique,
  myhfm_account text not null,
  receiver_name text,
  receiver_wallet text not null,
  receiver_method text,
  amount numeric not null,
  currency text not null default 'EGP',
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'converted')),
  reviewed_by text,
  reviewed_at timestamptz,
  rejection_note text,
  converted_payout_request_id uuid references public.payout_requests(id) on delete set null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists payout_link_requests_status_idx on public.payout_link_requests (status, created_at desc);
create index if not exists payout_link_requests_link_idx on public.payout_link_requests (payout_link_id);

alter table public.payout_links enable row level security;
alter table public.payout_link_requests enable row level security;
revoke all on public.payout_links from anon, authenticated;
revoke all on public.payout_link_requests from anon, authenticated;
