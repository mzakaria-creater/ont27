-- The operations_admin row already carried can_approve on approval-queue but
-- could not view the screen, while deposit decisions are enforced against the
-- deposits page key. Align both server gates for this role only.
update public.role_page_permissions
set can_view = true
where role_key = 'operations_admin'
  and page_key = 'approval-queue';

update public.role_page_permissions
set can_approve = true
where role_key = 'operations_admin'
  and page_key = 'deposits';
