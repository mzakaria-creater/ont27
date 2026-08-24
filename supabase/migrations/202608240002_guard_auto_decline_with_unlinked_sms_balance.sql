CREATE OR REPLACE FUNCTION public.sweep_auto_decline_stale_unmatched(p_grace_minutes integer DEFAULT NULL::integer, p_score_threshold integer DEFAULT NULL::integer)
 RETURNS TABLE(out_tx_id bigint, declined boolean, note text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r RECORD;
  v_result RECORD;
  v_score numeric;
  v_ids uuid[];
  v_sms_healthy boolean;
  v_effective_grace integer;
  v_reason_before text;
  v_reason_after text;
  v_turbo boolean;
  v_cfg_grace integer;
  v_cfg_threshold integer;
  v_breaker_on boolean;
  v_has_free_candidate_sms boolean;
BEGIN
  SELECT coalesce(decline_grace_minutes,5), coalesce(score_threshold,60), coalesce(turbo_mode,false), coalesce(sms_feed_circuit_breaker_enabled,true)
    INTO v_cfg_grace, v_cfg_threshold, v_turbo, v_breaker_on
    FROM public.automation_settings WHERE id=1;

  p_grace_minutes := coalesce(p_grace_minutes, v_cfg_grace);
  p_score_threshold := coalesce(p_score_threshold, v_cfg_threshold);

  SELECT (max(received_at) > now() - interval '20 minutes') INTO v_sms_healthy FROM public.inbound_sms;

  v_effective_grace := CASE
    WHEN NOT coalesce(v_sms_healthy, false) AND v_breaker_on THEN 15
    WHEN v_turbo THEN LEAST(p_grace_minutes, 1)
    ELSE p_grace_minutes
  END;

  SELECT array_agg(rq.id) INTO v_ids
  FROM public.review_queue rq
  JOIN public.maven_transactions mt ON mt.tx_id = rq.tx_id
  WHERE rq.decision = 'pending_review'
    AND rq.source = 'maven'
    AND mt.status = 'PENDING'
    AND mt.created_utc::timestamptz < now() - make_interval(mins => v_effective_grace)
    AND (SELECT id FROM public.resolve_automation_rule(mt.merchant, NULL, mt.amount)) IS NOT NULL
    AND public.is_source_enabled('maven');

  -- FIX 2026-07-27: guard now blocks the Maven-status sync whenever there is ANY
  -- live evidence attached (matched_sms_id set AND that sms is either already
  -- consumed by this same tx, OR still free/unconsumed). Previously only the
  -- "consumed by this tx" case was protected, so a high-score match whose sms
  -- had not yet been marked consumed could get silently overwritten to whatever
  -- stale status Maven reported (e.g. tx 138446657, 85% match, discarded to
  -- DECLINED). Now such rows are left in pending_review for a human/normal
  -- evaluate_transaction_for_auto_decision pass instead of being auto-synced away.
  UPDATE public.review_queue rq2
  SET decision = CASE WHEN mt2.status = 'PAID' THEN 'auto_approved' ELSE 'auto_declined' END,
      decision_reason = format('Sweep cleanup: Maven already %s', mt2.status),
      decided_by = 'system', decided_at = now(),
      target_status = CASE WHEN mt2.status = 'PAID' THEN 'APPROVED' ELSE 'DECLINED' END
  FROM public.maven_transactions mt2
  WHERE mt2.tx_id = rq2.tx_id
    AND rq2.decision = 'pending_review'
    AND mt2.status IN ('DECLINED', 'PAID')
    AND NOT EXISTS (
      SELECT 1 FROM public.inbound_sms s
      WHERE s.id = rq2.matched_sms_id
        AND (s.consumed_by_tx_id = rq2.tx_id OR s.consumed_by_tx_id IS NULL)
    );

  IF v_ids IS NULL THEN RETURN; END IF;

  FOR r IN
    SELECT rq.id AS review_id, rq.tx_id AS row_tx_id, rq.amount AS row_amount, mt.merchant, mt.sub_merchant, mt.to_account_number, mt.created_utc
    FROM public.review_queue rq
    JOIN public.maven_transactions mt ON mt.tx_id = rq.tx_id
    WHERE rq.id = ANY(v_ids) AND rq.decision = 'pending_review'
  LOOP
    SELECT decision_reason INTO v_reason_before FROM public.review_queue WHERE id = r.review_id;

    SELECT * INTO v_result FROM public.evaluate_transaction_for_auto_decision(
      r.row_tx_id, r.row_amount, r.merchant, r.sub_merchant, 'maven');

    IF v_result.decision = 'auto_approved' THEN
      out_tx_id := r.row_tx_id; declined := false; note := 'Now matches auto-approve criteria — approved on re-check';
      RETURN NEXT; CONTINUE;
    END IF;

    SELECT match_score, decision_reason INTO v_score, v_reason_after FROM public.review_queue WHERE id = r.review_id;
    v_score := coalesce(v_score, 0);

    IF v_score >= p_score_threshold THEN
      IF v_reason_after IS NULL OR v_reason_after = v_reason_before OR v_reason_after LIKE 'No matching SMS yet%' OR v_reason_after LIKE 'مفيش رسالة%' THEN
        UPDATE public.review_queue
        SET decision_reason = format('Pending >%s min, match score %s%% (>= %s%%) — routed to manual approval%s', v_effective_grace, v_score, p_score_threshold, CASE WHEN v_turbo THEN ' [⚡TURBO]' ELSE '' END)
        WHERE id = r.review_id;
      END IF;
      out_tx_id := r.row_tx_id; declined := false; note := format('Score %s%% >= threshold — routed to manual approval (%s)', v_score, coalesce(v_reason_after, ''));
      RETURN NEXT;
    ELSE
      IF NOT coalesce(v_sms_healthy, false) AND v_breaker_on THEN
        UPDATE public.review_queue
        SET decision_reason = '⏸️ قاطع أمان: فيد الرسايل واقف — القرار متجمد بدل الرفض بصفر أدلة، هيتراجع تلقائياً أول ما الفيد يرجع'
        WHERE id = r.review_id AND (decision_reason IS NULL OR decision_reason NOT LIKE '⏸️%');
        out_tx_id := r.row_tx_id; declined := false; note := 'parked — SMS feed down (circuit breaker active)';
        RETURN NEXT; CONTINUE;
      END IF;

      -- Never decline while a clean, unconsumed financial SMS could belong to
      -- this transaction. Exact amount + wallet + +/-5 minutes + balance evidence
      -- makes the candidate conservative; the matcher/manual review gets first use.
      SELECT EXISTS (
        SELECT 1 FROM public.inbound_sms s
        WHERE s.consumed_by_tx_id IS NULL
          AND s.amount = r.row_amount
          AND s.received_at BETWEEN r.created_utc::timestamptz - interval '5 minutes'
                                AND r.created_utc::timestamptz + interval '5 minutes'
          AND regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\\D', '', 'g')
              = regexp_replace(coalesce(r.to_account_number, ''), '\\D', '', 'g')
          AND s.balance_after IS NOT NULL
          AND coalesce(s.sms_category, '') IN ('deposit', 'received', 'income')
      ) INTO v_has_free_candidate_sms;

      IF v_has_free_candidate_sms THEN
        UPDATE public.review_queue
        SET decision_reason = 'Pending: unlinked SMS candidate within +/-5 min with exact amount, wallet and balance evidence — decline blocked'
        WHERE id = r.review_id;
        out_tx_id := r.row_tx_id; declined := false; note := 'candidate SMS exists — auto-decline blocked';
        RETURN NEXT; CONTINUE;
      END IF;

      UPDATE public.review_queue
      SET decision = 'auto_declined',
          decision_reason = format('No clean match after %s min (score %s%% < %s%%) — auto-declined', v_effective_grace, v_score, p_score_threshold),
          decided_by = 'system', decided_at = now(), target_status = 'DECLINED'
      WHERE id = r.review_id;

      INSERT INTO public.browser_jobs (tx_id, amount, target_status, source, state)
      VALUES (r.row_tx_id, r.row_amount, 'DECLINED', 'auto_engine', 'pending')
      ON CONFLICT (tx_id, target_status) WHERE state IN ('pending','running') DO NOTHING;

      out_tx_id := r.row_tx_id; declined := true; note := format('Score %s%% < threshold — auto-declined after %s min', v_score, v_effective_grace);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$
;
UPDATE public.automation_settings SET decline_grace_minutes=5, turbo_mode=false, updated_at=now(), updated_by='codex:user-request:5min-no-sms-decline' WHERE id=1;
UPDATE public.automation_rules_v2 SET name='decline_grace_5min', name_ar='رفض بعد 5 دقائق بدون SMS', description='Auto-decline only after 5 minutes and only when no clean unlinked SMS candidate exists around transaction time with exact amount, wallet and balance evidence', conditions=jsonb_build_object('check','grace_period','minutes',5,'requires_no_unlinked_sms',true,'requires_balance_guard',true), time_window_seconds=300, updated_at=now() WHERE id=11;
