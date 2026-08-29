-- Permission invariants for the four day-to-day control-room roles.
-- An action can never be enabled on a page the role cannot view.
update public.role_page_permissions
set can_view = true
where role_key in ('operator','operations_admin','admin','super_admin')
  and (can_edit or can_create or can_delete or can_approve);

-- Export is not a reason to expose a page. Remove stale export flags from
-- intentionally hidden screens.
update public.role_page_permissions
set can_export = false
where role_key in ('operator','operations_admin','admin') and not can_view;

-- Explicit automation split: viewing rules is separate from changing them.
insert into public.role_page_permissions
  (role_key,page_key,can_view,can_create,can_edit,can_delete,can_approve,can_export)
values
  ('operator','automation',true,false,false,false,false,false),
  ('operator','automation_rules',true,false,false,false,false,false),
  ('operator','automation_templates',true,false,false,false,false,false),
  ('operations_admin','automation',true,false,false,false,false,false),
  ('operations_admin','automation_rules',true,false,false,false,false,false),
  ('operations_admin','automation_templates',true,false,false,false,false,false),
  ('admin','automation',true,true,true,false,true,true),
  ('admin','automation_rules',true,true,true,true,true,true),
  ('admin','automation_templates',true,true,true,true,true,true),
  ('super_admin','automation',true,true,true,true,true,true),
  ('super_admin','automation_rules',true,true,true,true,true,true),
  ('super_admin','automation_templates',true,true,true,true,true,true)
on conflict (role_key,page_key) do update set
  can_view=excluded.can_view, can_create=excluded.can_create,
  can_edit=excluded.can_edit, can_delete=excluded.can_delete,
  can_approve=excluded.can_approve, can_export=excluded.can_export;

-- Operations admins own the operational queue; operators may work individual
-- transactions but cannot change automation or the global permission matrix.
update public.role_page_permissions set can_view=true,can_edit=true,can_approve=true
where role_key='operations_admin' and page_key in
 ('approvals','approval-queue','assigned_to_me','pending_deposits','pending_payouts','deposits','payouts','transactions','all_transactions','manual_review','review');

update public.role_page_permissions set can_view=true
where role_key='operator' and page_key in
 ('approval-queue','assigned_to_me','pending_deposits','pending_payouts','deposits','payouts','transactions','all_transactions','manual_review','review');

-- Preserve the hard security boundary regardless of future matrix edits.
update public.role_page_permissions
set can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false
where role_key <> 'super_admin' and page_key='binance_p2p_config';
