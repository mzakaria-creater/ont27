-- Security hardening requested after the Supabase security review.
-- Server routes use the service-role client; browsers and anon clients must not
-- read or mutate operational, financial, credential, or settlement tables.

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'access_team_members','access_teams','auto_decision_trace',
    'binance_p2p_execution_log','cash_sms_settlements','device_keys',
    'financial_ledger_entries','idempotency_keys','internal_chat_members',
    'internal_chat_messages','internal_chat_presence','internal_chat_rooms',
    'merchant_api_keys','panel_refresh_tokens','panel_user_action_tokens',
    'panel_users_2fa','payment_links','payment_method_countries',
    'payment_method_country_merchants','payout_execution_settings',
    'provider_sync_leases','revenue_share_rules','sms_intake_auth_log',
    'sms_withdrawal_assignments','staff_attendance_sessions','support_tickets',
    'transaction_edit_requests','user_access_scopes','user_page_permissions',
    'wallet_balance_alert_config','wallet_balance_alert_state',
    'wallet_balance_movements','webhook_delivery_log','webhook_endpoints',
    'payment_transactions','transaction_operations','gateway_logs',
    'payment_idempotency_keys'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      policy_name := 'service_role_all_' || table_name;
      execute format('drop policy if exists %I on public.%I', policy_name, table_name);
      execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', policy_name, table_name);
    end if;
  end loop;
end $$;

-- These two merchant catalogue tables were created before the hardened
-- server-only access pattern. They contain no public checkout secrets, but
-- are still kept server-only so the API remains the single access point.
alter table if exists public.master_merchants enable row level security;
drop policy if exists service_role_all_master_merchants on public.master_merchants;
create policy service_role_all_master_merchants on public.master_merchants for all to service_role using (true) with check (true);
alter table if exists public.sub_merchants enable row level security;
drop policy if exists service_role_all_sub_merchants on public.sub_merchants;
create policy service_role_all_sub_merchants on public.sub_merchants for all to service_role using (true) with check (true);
