-- MelBet blacklist enforcement is identity-safe and phone-only. Existing
-- linked SMS evidence still takes precedence and remains manual review.
DO $migration$
DECLARE
  v_definition text;
  v_marker text := '    SELECT * INTO v_result FROM public.evaluate_transaction_for_auto_decision(';
  v_insert text := $body$
    IF r.merchant ILIKE '%MelBet%'
       AND NULLIF(regexp_replace(coalesce(r.sender_number, ''), '\D', '', 'g'), '') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.api_risk_blacklist b
         WHERE b.type = 'phone'
           AND regexp_replace(coalesce(b.value, ''), '\D', '', 'g')
             = regexp_replace(r.sender_number, '\D', '', 'g')
       ) THEN
      UPDATE public.review_queue
      SET decision = 'auto_declined',
          decision_reason = 'Blacklisted phone number — MelBet auto-decline',
          decided_by = 'system', decided_at = now(), target_status = 'DECLINED'
      WHERE id = r.review_id;
      INSERT INTO public.browser_jobs (tx_id, amount, target_status, source, state)
      VALUES (r.row_tx_id, r.row_amount, 'DECLINED', 'auto_engine', 'pending')
      ON CONFLICT (tx_id, target_status) WHERE state IN ('pending', 'running') DO NOTHING;
      out_tx_id := r.row_tx_id; declined := true;
      note := 'blacklisted phone; MelBet auto-decline'; RETURN NEXT; CONTINUE;
    END IF;

$body$;
BEGIN
  SELECT pg_get_functiondef('public.sweep_auto_decline_stale_unmatched(integer,integer)'::regprocedure)
    INTO v_definition;
  IF v_definition IS NULL OR position(v_marker IN v_definition) = 0 THEN
    RAISE EXCEPTION 'sweep_auto_decline_stale_unmatched marker not found';
  END IF;
  v_definition := replace(v_definition, v_marker, v_insert || v_marker);
  EXECUTE v_definition;
END;
$migration$;
