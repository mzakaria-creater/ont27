-- Reconnect both NGPay automation decisions with the requested grace windows.
UPDATE public.automation_settings
SET automation_enabled = true,
    auto_decline_enabled = true,
    ngpay_enabled = true,
    decline_grace_minutes = 4,
    updated_by = 'system-reconnect',
    updated_at = now()
WHERE id = 1;

UPDATE public.automation_rules_scoped
SET enabled = true,
    time_window_minutes = CASE WHEN action_type = 'decline' THEN 4 ELSE time_window_minutes END,
    updated_at = now()
WHERE master_merchant = 'ngpay'
  AND action_type IN ('approve', 'decline');

-- Retained clients with >50% paid history get an 8-minute grace window.
-- Keep the existing function guards and only change the retention interval.
DO $migration$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('public.sweep_auto_decline_stale_unmatched(integer,integer)'::regprocedure)
    INTO definition;
  IF definition IS NULL THEN
    RAISE EXCEPTION 'sweep_auto_decline_stale_unmatched is missing';
  END IF;
  definition := replace(definition,
    $$AND r.created_utc::timestamptz > now() - interval '10 minutes'$$,
    $$AND r.created_utc::timestamptz > now() - interval '8 minutes'$$);
  definition := replace(definition,
    'Retained client with paid SMS history — 10-minute SMS grace window',
    'Retained client with paid SMS history (>50% paid) — 8-minute SMS grace window');
  definition := replace(definition,
    'retained client; extended SMS grace',
    'retained client; 8-minute SMS grace');
  EXECUTE definition;
END;
$migration$;
