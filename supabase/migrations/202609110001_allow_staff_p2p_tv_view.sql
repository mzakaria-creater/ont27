-- P2P TV is an operational read-only wall. It uses SMS, wallet and payout
-- read APIs; it does not grant Binance credentials or configuration access.
insert into public.role_page_permissions
  (role_key, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export)
select r.role_key, 'sms_live', true, false, false, false, false, false
from public.app_roles r
where r.role_key in ('agent', 'operator')
on conflict (role_key, page_key) do update set
  can_view = true;

insert into public.role_page_permissions
  (role_key, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export)
select r.role_key, 'wallets', true, false, false, false, false, false
from public.app_roles r
where r.role_key in ('agent', 'operator')
on conflict (role_key, page_key) do update set
  can_view = true;

insert into public.role_page_permissions
  (role_key, page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export)
select r.role_key, 'payouts', true, false, false, false, false, false
from public.app_roles r
where r.role_key in ('agent', 'operator')
on conflict (role_key, page_key) do update set
  can_view = true;
