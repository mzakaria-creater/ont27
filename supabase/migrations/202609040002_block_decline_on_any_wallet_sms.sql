-- Keep deposits in review when money evidence exists on another wallet.
-- Wallet mismatch is an investigation signal, not a decline signal.
CREATE OR REPLACE FUNCTION public.sweep_auto_decline_stale_unmatched(
  p_grace_minutes integer DEFAULT NULL,
  p_score_threshold integer DEFAULT NULL
)
RETURNS TABLE(out_tx_id bigint, declined boolean, note text)
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  r record;
  v_result record;
  v_score numeric;
  v_cfg_grace integer;
  v_cfg_threshold integer;
  v_breaker_on boolean;
  v_turbo boolean;
  v_sms_healthy boolean;
  v_effective_grace integer;
  v_any_wallet_candidate boolean;
  v_tx_wallet text;
  v_candidate_wallet text;
BEGIN
  SELECT coalesce(decline_grace_minutes, 5), coalesce(score_threshold, 60),
         coalesce(turbo_mode, false), coalesce(sms_feed_circuit_breaker_enabled, true)
    INTO v_cfg_grace, v_cfg_threshold, v_turbo, v_breaker_on
    FROM public.automation_settings WHERE id = 1;
  p_grace_minutes := coalesce(p_grace_minutes, v_cfg_grace);
  p_score_threshold := coalesce(p_score_threshold, v_cfg_threshold);
  SELECT max(received_at) > now() - interval '20 minutes' INTO v_sms_healthy
    FROM public.inbound_sms;
  v_effective_grace := CASE
    WHEN not coalesce(v_sms_healthy, false) AND v_breaker_on THEN 15
    WHEN v_turbo THEN least(p_grace_minutes, 1)
    ELSE p_grace_minutes END;

  FOR r IN
    SELECT rq.id review_id, rq.tx_id row_tx_id, rq.amount row_amount,
           mt.merchant, mt.sub_merchant, mt.created_utc,
           mt.receiving_wallet, mt.to_account_number
    FROM public.review_queue rq
    JOIN public.maven_transactions mt ON mt.tx_id = rq.tx_id
    WHERE rq.decision = 'pending_review' AND rq.source = 'maven'
      AND mt.status = 'PENDING'
      AND public.is_source_enabled('maven')
      AND mt.created_utc::timestamptz < now() - make_interval(mins => v_effective_grace)
      AND (SELECT id FROM public.resolve_automation_rule(mt.merchant, NULL, mt.amount)) IS NOT NULL
  LOOP
    SELECT * INTO v_result FROM public.evaluate_transaction_for_auto_decision(
      r.row_tx_id, r.row_amount, r.merchant, r.sub_merchant, 'maven');
    IF v_result.decision = 'auto_approved' THEN
      out_tx_id := r.row_tx_id; declined := false;
      note := 'approved by matching engine'; RETURN NEXT; CONTINUE;
    END IF;
    SELECT coalesce(match_score, 0) INTO v_score
      FROM public.review_queue WHERE id = r.review_id;
    IF v_score >= p_score_threshold THEN
      UPDATE public.review_queue
      SET decision_reason = format('Pending: match score %s%% requires human review', v_score)
      WHERE id = r.review_id;
      out_tx_id := r.row_tx_id; declined := false;
      note := 'score routed to manual review'; RETURN NEXT; CONTINUE;
    END IF;
    IF NOT coalesce(v_sms_healthy, false) AND v_breaker_on THEN
      UPDATE public.review_queue
      SET decision_reason = 'SMS feed unavailable — decision paused'
      WHERE id = r.review_id;
      out_tx_id := r.row_tx_id; declined := false;
      note := 'SMS circuit breaker'; RETURN NEXT; CONTINUE;
    END IF;

    -- Critical guard: amount + time on ANY receiving wallet is sufficient to
    -- block auto-decline. We deliberately do not link it automatically: the
    -- wallet discrepancy must be investigated by an operator first.
    SELECT EXISTS (
      SELECT 1 FROM public.inbound_sms s
      WHERE s.consumed_by_tx_id IS NULL
        AND coalesce(s.is_blocked, false) = false
        AND coalesce(s.sms_category, '') IN ('deposit', 'received', 'income')
        AND s.amount = r.row_amount
        AND s.received_at BETWEEN r.created_utc::timestamptz - interval '10 minutes'
                              AND r.created_utc::timestamptz + interval '10 minutes'
    ),
    regexp_replace(coalesce(r.receiving_wallet, r.to_account_number, ''), '\D', '', 'g')
    INTO v_any_wallet_candidate, v_tx_wallet;
    IF v_any_wallet_candidate THEN
      SELECT regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g')
        INTO v_candidate_wallet
      FROM public.inbound_sms s
      WHERE s.consumed_by_tx_id IS NULL
        AND coalesce(s.is_blocked, false) = false
        AND coalesce(s.sms_category, '') IN ('deposit', 'received', 'income')
        AND s.amount = r.row_amount
        AND s.received_at BETWEEN r.created_utc::timestamptz - interval '10 minutes'
                              AND r.created_utc::timestamptz + interval '10 minutes'
      ORDER BY abs(extract(epoch FROM (s.received_at - r.created_utc::timestamptz)))
      LIMIT 1;
      UPDATE public.review_queue
      SET decision_reason = CASE
        WHEN v_candidate_wallet IS DISTINCT FROM v_tx_wallet
          THEN format('Pending: unlinked SMS same amount within +/-10 min on wallet %s (transaction wallet %s) — wallet discrepancy review', coalesce(v_candidate_wallet, 'unknown'), coalesce(v_tx_wallet, 'unknown'))
        ELSE 'Pending: unlinked SMS same amount within +/-10 min — decline blocked'
      END
      WHERE id = r.review_id;
      out_tx_id := r.row_tx_id; declined := false;
      note := 'candidate SMS exists on a wallet; auto-decline blocked'; RETURN NEXT; CONTINUE;
    END IF;

    UPDATE public.review_queue
    SET decision = 'auto_declined',
        decision_reason = format('No clean match after %s min (score %s%% < %s%%) — auto-declined', v_effective_grace, v_score),
        decided_by = 'system', decided_at = now(), target_status = 'DECLINED'
    WHERE id = r.review_id;
    INSERT INTO public.browser_jobs (tx_id, amount, target_status, source, state)
    VALUES (r.row_tx_id, r.row_amount, 'DECLINED', 'auto_engine', 'pending')
    ON CONFLICT (tx_id, target_status) WHERE state IN ('pending', 'running') DO NOTHING;
    out_tx_id := r.row_tx_id; declined := true;
    note := 'no SMS evidence; auto-declined'; RETURN NEXT;
  END LOOP;
END;
$function$;
