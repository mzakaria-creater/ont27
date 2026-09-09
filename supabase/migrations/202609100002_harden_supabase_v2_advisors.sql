alter view public.v_rpt_usdt set (security_invoker = true);
alter view public.v_rpt_payouts set (security_invoker = true);
alter view public.v_rpt_duplicates set (security_invoker = true);

alter function public.sync_payment_account_balance() set search_path = public, pg_temp;
alter function public.custom_access_token_hook(jsonb) set search_path = public, pg_temp;
alter function public.mark_supported_sms_source() set search_path = public, pg_temp;

revoke execute on function public.crm_phone_for_name(text) from public, anon, authenticated;
revoke execute on function public.link_wallet_sms_to_paid_transactions(integer) from public, anon, authenticated;
revoke execute on function public.list_merchant_api_keys(uuid) from public, anon, authenticated;
revoke execute on function public.ontarget_tx_verdict(text) from public, anon, authenticated;
revoke execute on function public.performance_regression_scan(text, numeric, interval, boolean, numeric) from public, anon, authenticated;
revoke execute on function public.prevent_duplicate_sms_maven_link() from public, anon, authenticated;
revoke execute on function public.prevent_sms_reassignment() from public, anon, authenticated;
revoke execute on function public.sms_auto_match_sweep() from public, anon, authenticated;
revoke execute on function public.support_ticket_set_status(bigint, text, text) from public, anon, authenticated;
revoke execute on function public.wallet_balance_alert_sweep() from public, anon, authenticated;

grant execute on function public.crm_phone_for_name(text) to service_role;
grant execute on function public.link_wallet_sms_to_paid_transactions(integer) to service_role;
grant execute on function public.list_merchant_api_keys(uuid) to service_role;
grant execute on function public.ontarget_tx_verdict(text) to service_role;
grant execute on function public.performance_regression_scan(text, numeric, interval, boolean, numeric) to service_role;
grant execute on function public.sms_auto_match_sweep() to service_role;
grant execute on function public.support_ticket_set_status(bigint, text, text) to service_role;
grant execute on function public.wallet_balance_alert_sweep() to service_role;

alter policy sel_panel_users_self on public.panel_users
  using ((id)::text = ((select auth.jwt()) ->> 'sub'::text));

alter policy "Users log their own consent decisions" on public.oauth_consent_events
  with check (user_id = (select auth.uid()));
drop policy if exists "Users read their own consent decisions" on public.oauth_consent_events;
drop policy if exists "Settings admins read all consent decisions" on public.oauth_consent_events;
create policy "Users or settings admins read consent decisions"
  on public.oauth_consent_events for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_page_permission('settings','view')));

alter policy "Users log their own denied access" on public.access_denial_events
  with check (user_id = (select auth.uid()));
drop policy if exists "Users read their own denied access" on public.access_denial_events;
drop policy if exists "Settings admins read all denied access" on public.access_denial_events;
create policy "Users or settings admins read denied access"
  on public.access_denial_events for select to authenticated
  using (user_id = (select auth.uid()) or (select public.has_page_permission('settings','view')));

drop policy if exists sel_support_complaint_realtime on public.telegram_alerts;
drop policy if exists sel_telegram_alerts on public.telegram_alerts;
drop policy if exists sel_wrongful_decline_realtime on public.telegram_alerts;
create policy sel_telegram_alerts_combined
  on public.telegram_alerts for select to authenticated
  using (
    alert_type = 'wrongful_auto_decline'
    or (alert_type = 'complaint_filed' and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'app_role'), '') = any (array['owner','admin','super_admin','operator','operations_admin']))
    or (select public.has_page_permission('telegram_bot','view'))
    or (select public.has_page_permission('settings','view'))
  );

drop index if exists public.ux_mt_tx_id;
drop index if exists public.support_tickets_status_idx;

create index if not exists audit_log_master_merchant_id_idx on public.audit_log(master_merchant_id);
create index if not exists checkout_sessions_exchange_rate_id_idx on public.checkout_sessions(exchange_rate_id);
create index if not exists checkout_sessions_local_deposit_channel_id_idx on public.checkout_sessions(local_deposit_channel_id);
create index if not exists client_transactions_tx_id_idx on public.client_transactions(tx_id);
create index if not exists crm_client_names_normalized_phone_idx on public.crm_client_names(normalized_phone);
create index if not exists exchange_rates_source_id_idx on public.exchange_rates(source_id);
create index if not exists internal_chat_presence_typing_room_id_idx on public.internal_chat_presence(typing_room_id);
create index if not exists local_deposit_channels_master_merchant_id_idx on public.local_deposit_channels(master_merchant_id);
create index if not exists merchant_api_keys_merchant_id_idx on public.merchant_api_keys(merchant_id);
create index if not exists merchants_hierarchy_master_merchant_id_idx on public.merchants_hierarchy(master_merchant_id);
create index if not exists panel_user_action_tokens_user_id_idx on public.panel_user_action_tokens(user_id);
create index if not exists panel_users_role_idx on public.panel_users(role);
create index if not exists payment_links_created_by_idx on public.payment_links(created_by);
create index if not exists payment_links_merchant_id_idx on public.payment_links(merchant_id);
create index if not exists payment_pools_master_merchant_id_idx on public.payment_pools(master_merchant_id);
create index if not exists role_migration_map_new_role_key_idx on public.role_migration_map(new_role_key);
create index if not exists sms_maven_matches_tx_id_idx on public.sms_maven_matches(tx_id);
create index if not exists webhook_endpoints_merchant_id_idx on public.webhook_endpoints(merchant_id);
