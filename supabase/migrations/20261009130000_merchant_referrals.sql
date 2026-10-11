-- Panel-staff merchant referrals: track which panel_users account referred
-- a given merchant, plus a lead-capture table for the public referral-link
-- flow. The link itself carries an HS256-signed token (same PANEL_JWT_SECRET
-- as panel session tokens, distinct 'merchant_referral' purpose claim) --
-- stateless, no separate link-secret table needed.

alter table merchants add column if not exists referred_by_user_id uuid references panel_users(id);

create table if not exists merchant_referral_leads (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references panel_users(id),
  business_name text not null,
  contact_name text,
  phone text,
  email text,
  notes text,
  status text not null default 'pending' check (status in ('pending','converted','dismissed')),
  linked_merchant_id uuid references merchants(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists merchant_referral_leads_referrer_idx on merchant_referral_leads(referrer_user_id);
create index if not exists merchant_referral_leads_status_idx on merchant_referral_leads(status);

-- Server (service role) only -- no anon/authenticated PostgREST access.
alter table merchant_referral_leads enable row level security;
