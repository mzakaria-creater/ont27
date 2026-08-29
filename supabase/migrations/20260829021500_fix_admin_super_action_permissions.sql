-- Complete the super-admin matrix, and restore operational action permissions
-- for admins. Sensitive Binance configuration remains super_admin-only.
update public.role_page_permissions
set can_view = true,
    can_create = true,
    can_edit = true,
    can_delete = true,
    can_approve = true,
    can_export = true
where role_key = 'super_admin';

update public.role_page_permissions
set can_edit = true,
    can_approve = true
where role_key = 'admin'
  and page_key in (
    'transactions', 'all_transactions', 'approvals', 'approval-queue',
    'review', 'manual_review', 'pending_deposits', 'pending_payouts',
    'deposits', 'payouts', 'sms_live'
  );

-- Explicit safety invariant: admins must never inherit Binance credentials or
-- trading-limit configuration through the broad operational grant above.
update public.role_page_permissions
set can_view = false,
    can_create = false,
    can_edit = false,
    can_delete = false,
    can_approve = false,
    can_export = false
where role_key = 'admin' and page_key = 'binance_p2p_config';
