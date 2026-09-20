alter table public.sms_withdrawal_assignments
  drop constraint if exists sms_withdrawal_assignments_assignment_type_check;

alter table public.sms_withdrawal_assignments
  add constraint sms_withdrawal_assignments_assignment_type_check
  check (assignment_type in ('payout', 'p2p_usdt', 'cash_return', 'mina_cash'));
