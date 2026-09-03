-- PayFuture's legacy payload names the sub-merchant/site in reference5
-- (or SiteId on the older RSC payload). Preserve the provider identifier;
-- do not guess a display name that is not present in the payload.
with candidates as (
  select distinct trim(coalesce(nullif(t.raw->>'reference5',''), nullif(t.raw->>'reference4',''), nullif(t.raw->>'SiteId',''))) as name
  from public.maven_transactions t
  where lower(coalesce(t.master_merchant,'')) = 'payfuture'
    and jsonb_typeof(t.raw) = 'object'
    and trim(coalesce(nullif(t.raw->>'reference5',''), nullif(t.raw->>'reference4',''), nullif(t.raw->>'SiteId',''))) ~ '^[0-9]+$'
)
insert into public.merchants_hierarchy
  (master_merchant_id, name, active, payin_commission_pct, payout_commission_pct)
select mm.id, c.name, true, 0, 0
from public.master_merchants mm
join candidates c on true
where mm.code = 'payfuture'
  and not exists (
    select 1 from public.merchants_hierarchy h
    where h.master_merchant_id = mm.id and lower(trim(h.name)) = lower(c.name)
  );

with candidates as (
  select t.tx_id, trim(coalesce(nullif(t.raw->>'reference5',''), nullif(t.raw->>'reference4',''), nullif(t.raw->>'SiteId',''))) as name
  from public.maven_transactions t
  where lower(coalesce(t.master_merchant,'')) = 'payfuture'
    and (t.sub_merchant is null or trim(t.sub_merchant) = '')
    and jsonb_typeof(t.raw) = 'object'
    and trim(coalesce(nullif(t.raw->>'reference5',''), nullif(t.raw->>'reference4',''), nullif(t.raw->>'SiteId',''))) ~ '^[0-9]+$'
)
update public.maven_transactions t
set sub_merchant = c.name
from candidates c
where t.tx_id = c.tx_id;

