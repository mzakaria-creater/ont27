alter table public.settlement_merchant_payments
  add column if not exists payin_fee_percent numeric(7,4) not null default 0 check (payin_fee_percent between 0 and 100),
  add column if not exists payin_fee_fixed numeric(18,2) not null default 0 check (payin_fee_fixed >= 0),
  add column if not exists payout_fee_percent numeric(7,4) not null default 0 check (payout_fee_percent between 0 and 100),
  add column if not exists payout_fee_fixed numeric(18,2) not null default 0 check (payout_fee_fixed >= 0),
  add column if not exists settlement_date date,
  add column if not exists proof_url text,
  add column if not exists proof_file_name text;
