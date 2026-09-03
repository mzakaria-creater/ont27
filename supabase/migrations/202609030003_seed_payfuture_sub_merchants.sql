-- Keep the PayFuture sub-merchant catalogue available to payment-method
-- assignment and fee/settlement screens. These are the live names supplied
-- in the PayFuture merchant mapping (and the legacy 1621 identifier already
-- present on imported PayFuture transactions).
insert into public.merchants_hierarchy
  (master_merchant_id, name, active, payin_commission_pct, payout_commission_pct)
select mm.id, v.name, true, 0, 0
from public.master_merchants mm
cross join (values
  ('Test-Acs-01-M'),
  ('Test-AA-PROD-M'),
  ('Avadapay-ML-LP-EGP-iWallet'),
  ('Softgamings-ML-LP-EGP-iWallet'),
  ('Paysnapper-ML-LP-EGP-iWallet'),
  ('Dalapay-ML-LP-EGP-iWallet'),
  ('Cwinz-ML-LP-EGP-iWallet'),
  ('1621')
) as v(name)
where mm.code = 'payfuture'
  and not exists (
    select 1
    from public.merchants_hierarchy h
    where h.master_merchant_id = mm.id
      and lower(trim(h.name)) = lower(trim(v.name))
  );

