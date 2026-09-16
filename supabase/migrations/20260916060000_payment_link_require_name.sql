-- Let an operator require the customer's name at checkout, per link. Phone
-- and amount are already structurally required by the checkout form; name
-- is the one customer-facing field that today is always optional.
alter table public.payment_links
  add column if not exists require_name boolean not null default false;
