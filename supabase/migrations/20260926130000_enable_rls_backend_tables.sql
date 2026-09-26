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
