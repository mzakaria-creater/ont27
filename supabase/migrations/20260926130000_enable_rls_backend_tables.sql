-- These tables are accessed through the server's service-role client only.
-- Enable RLS and explicitly document that boundary; no anon/authenticated
-- client policy is granted.
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'api_risk_blacklist_backup_20260821', 'performance_alert_state',
    'payment_link_opens', 'binance_api_config', 'binance_p2p_requests',
    'merchant_settlement_transactions', 'merchant_settlements',
    'settlement_proofs', 'complaints', 'wallet_rotation_groups'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = v_table
          AND policyname = v_table || '_service_role_access'
      ) THEN
        EXECUTE format(
          'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
          v_table || '_service_role_access', v_table
        );
      END IF;
    END IF;
  END LOOP;
END $$;

-- Complete the same service-role policy for tables that already had RLS but
-- were missing a policy, and remove direct RPC execution from client roles.
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'approval_email_deliveries', 'approval_email_subscriptions',
    'payout_link_requests', 'payout_links', 'sms_feed_routes',
    'whatsapp_conversations', 'whatsapp_messages'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename=v_table
           AND policyname=v_table || '_service_role_access'
       ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        v_table || '_service_role_access', v_table
      );
    END IF;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION public.approve_pending_with_linked_sms() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_close_complaint_on_decision(bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_complaint(bigint,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_page_permission(text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.manual_link_sms_to_tx(bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_sms_to_telegram() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.open_complaint(bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tick_wallet_rotation_groups() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.toggle_auto_decline(boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_approve_on_sms_link() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_recheck_pending_transaction_identity() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.approve_pending_with_linked_sms() TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_close_complaint_on_decision(bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_complaint(bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_page_permission(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.manual_link_sms_to_tx(bigint,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_sms_to_telegram() TO service_role;
GRANT EXECUTE ON FUNCTION public.open_complaint(bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.tick_wallet_rotation_groups() TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_auto_decline(boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_approve_on_sms_link() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_recheck_pending_transaction_identity() TO service_role;
