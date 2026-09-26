-- A blacklisted client is still held for review when an operator assigns an
-- exact (100%) SMS match.  The assignment timestamp is review_queue.updated_at;
-- after 15 minutes the normal approval rules may dispatch PAID.
DO $migration$
DECLARE
  v_definition text;
  v_marker text;
BEGIN
  SELECT pg_get_functiondef('public.evaluate_and_dispatch_ngpay_decision_core(bigint)'::regprocedure)
    INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'evaluate_and_dispatch_ngpay_decision_core not found';
  END IF;

  v_definition := replace(v_definition,
    E'  v_blacklisted boolean;\n  v_any_approve_rule boolean := false;',
    E'  v_blacklisted boolean;\n  v_blacklisted_exact_sms boolean := false;\n  v_manual_review_at timestamptz;\n  v_any_approve_rule boolean := false;');

  v_marker := E'  -- blacklisted_sender_any_amount: a blocked phone is never eligible for payment, regardless of amount or configured limits.\n';
  IF position('blacklisted_exact_sms_manual_review' IN v_definition) = 0 THEN
    IF position(v_marker IN v_definition) = 0 THEN
      RAISE EXCEPTION 'blacklist marker not found';
    END IF;
    v_definition := replace(v_definition, v_marker, $body$
  -- Exact assigned SMS is a narrow exception to the blacklist rule.  Keep the
  -- transaction in manual review for 15 minutes from assignment, then let the
  -- normal approve rule verify and dispatch it.
  SELECT EXISTS (
    SELECT 1
    FROM public.inbound_sms s
    WHERE (s.consumed_by_tx_id = v_tx.tx_id OR s.matched_transaction_id = v_tx.tx_id OR s.maven_transaction_id = v_tx.tx_id::text)
      AND NOT coalesce(s.is_blocked, false)
      AND NOT coalesce(s.is_duplicate, false)
      AND coalesce(s.auto_match_score, 0) = 100
      AND s.amount = v_tx.amount
      AND right(regexp_replace(coalesce(s.sender_number, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(v_tx.sender_number, ''), '\D', '', 'g'), 10)
      AND right(regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g'), 10)
          = right(regexp_replace(coalesce(v_tx.receiving_wallet, v_tx.to_account_number, ''), '\D', '', 'g'), 10)
  ) INTO v_blacklisted_exact_sms;
  IF v_blacklisted_exact_sms THEN
    SELECT rq.updated_at INTO v_manual_review_at
    FROM public.review_queue rq
    WHERE rq.tx_id = v_tx.tx_id AND rq.source = 'maven'
    ORDER BY rq.updated_at DESC NULLS LAST LIMIT 1;
    IF v_manual_review_at IS NULL OR now() < v_manual_review_at + interval '15 minutes' THEN
      RETURN 'blacklisted_exact_sms_manual_review';
    END IF;
  END IF;
$body$ || v_marker);
  END IF;

  -- Both blacklist guards are retained for older revisions of the function;
  -- neither may fire for the exact-match exception.
  v_definition := replace(v_definition,
    E'  if nullif(regexp_replace(coalesce(v_tx.sender_number, ''''), ''\\D'', '''', ''g''), '''') is not null',
    E'  if not v_blacklisted_exact_sms and nullif(regexp_replace(coalesce(v_tx.sender_number, ''''), ''\\D'', '''', ''g''), '''') is not null');
  v_definition := replace(v_definition,
    E'  if v_blacklisted then\n',
    E'  if v_blacklisted and not v_blacklisted_exact_sms then\n');
  EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.sweep_auto_decline_stale_unmatched(integer,integer)'::regprocedure)
    INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'sweep_auto_decline_stale_unmatched not found';
  END IF;
  IF position('blacklisted exact SMS; manual review 15m' IN v_definition) > 0 THEN
    RETURN;
  END IF;
  v_definition := replace(v_definition,
    E'  v_linked_sms boolean;\n',
    E'  v_linked_sms boolean;\n  v_blacklisted_exact_sms boolean;\n  v_dispatch text;\n');
  v_definition := replace(v_definition,
    'SELECT rq.id review_id, rq.tx_id row_tx_id, rq.amount row_amount,',
    'SELECT rq.id review_id, rq.tx_id row_tx_id, rq.amount row_amount, rq.updated_at,');
  v_definition := replace(v_definition,
    E'    IF v_linked_sms THEN\n',
    $body$    IF v_linked_sms THEN
      SELECT EXISTS (
        SELECT 1 FROM public.maven_transactions tx
        JOIN public.inbound_sms s ON (s.consumed_by_tx_id = tx.tx_id OR s.matched_transaction_id = tx.tx_id OR s.maven_transaction_id = tx.tx_id::text)
        WHERE tx.tx_id = r.row_tx_id
          AND coalesce(s.auto_match_score, 0) = 100
          AND NOT coalesce(s.is_blocked, false)
          AND NOT coalesce(s.is_duplicate, false)
          AND s.amount = tx.amount
          AND right(regexp_replace(coalesce(s.sender_number, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(tx.sender_number, ''), '\D', '', 'g'), 10)
          AND right(regexp_replace(coalesce(s.confirmed_wallet_number, s.wallet_number, s.receiver_number, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(tx.receiving_wallet, tx.to_account_number, ''), '\D', '', 'g'), 10)
          AND EXISTS (SELECT 1 FROM public.api_risk_blacklist b WHERE b.type = 'phone' AND right(regexp_replace(coalesce(b.value, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(tx.sender_number, ''), '\D', '', 'g'), 10))
      ) INTO v_blacklisted_exact_sms;
      IF v_blacklisted_exact_sms THEN
        IF r.updated_at IS NULL OR now() < r.updated_at + interval '15 minutes' THEN
          UPDATE public.review_queue SET decision_reason = 'Blacklisted client with 100% SMS match — manual review; auto-approve after 15 minutes' WHERE id = r.review_id;
          out_tx_id := r.row_tx_id; declined := false; note := 'blacklisted exact SMS; manual review 15m'; RETURN NEXT; CONTINUE;
        END IF;
        v_dispatch := public.evaluate_and_dispatch_ngpay_decision_core(r.row_tx_id);
        IF v_dispatch LIKE 'dispatched_approve_request_%' THEN
          UPDATE public.review_queue SET decision_reason = '100% SMS match verified after 15-minute blacklist review — approval dispatched' WHERE id = r.review_id;
          out_tx_id := r.row_tx_id; declined := false; note := 'blacklisted exact SMS; approved after 15m'; RETURN NEXT; CONTINUE;
        END IF;
        UPDATE public.review_queue SET decision_reason = '100% SMS match retained for manual review: ' || v_dispatch WHERE id = r.review_id;
        out_tx_id := r.row_tx_id; declined := false; note := 'blacklisted exact SMS; approval not dispatched'; RETURN NEXT; CONTINUE;
      END IF;
      UPDATE public.review_queue SET decision_reason = 'Pending: SMS already linked to this transaction — auto-decline blocked; manual review required' WHERE id = r.review_id;
      out_tx_id := r.row_tx_id; declined := false; note := 'linked SMS; auto-decline blocked'; RETURN NEXT; CONTINUE;
    END IF;
$body$);
  -- The replacement above intentionally contains the complete linked-SMS
  -- branch; remove the original branch body left immediately after it.
  v_definition := replace(v_definition, E'    END IF;\n      UPDATE public.review_queue SET decision_reason = ''Pending: SMS already linked to this transaction — auto-decline blocked; manual review required'' WHERE id = r.review_id;\n      out_tx_id := r.row_tx_id; declined := false; note := ''linked SMS; auto-decline blocked''; RETURN NEXT; CONTINUE;\n    END IF;\n', E'    END IF;\n');
  EXECUTE v_definition;
END;
$migration$;

-- Keep the UI/configured grace bounded to the requested maximum. This does
-- not alter the 15-minute exact-match review clock above.
UPDATE public.automation_settings
SET decline_grace_minutes = least(greatest(coalesce(decline_grace_minutes, 5), 5), 15), updated_at = now()
WHERE id = 1;

-- Do not use review_queue.updated_at as the clock: the worker updates the
-- reason text on every sweep, which would otherwise reset the 15-minute timer.
DO $migration$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.sweep_auto_decline_stale_unmatched(integer,integer)'::regprocedure)
    INTO v_definition;
  IF position('v_review_started timestamptz' IN v_definition) = 0 THEN
    v_definition := replace(v_definition,
      E'  v_dispatch text;\n',
      E'  v_dispatch text;\n  v_review_started timestamptz;\n');
    v_definition := replace(v_definition,
      E'        IF r.updated_at IS NULL OR now() < r.updated_at + interval ''15 minutes'' THEN\n',
      E'        SELECT greatest(max(m.matched_at), max(s.processed_at), max(s.received_at)) INTO v_review_started\n        FROM public.inbound_sms s LEFT JOIN public.sms_maven_matches m ON m.sms_id = s.id\n        WHERE s.consumed_by_tx_id = r.row_tx_id OR s.matched_transaction_id = r.row_tx_id OR s.maven_transaction_id = r.row_tx_id::text;\n        IF v_review_started IS NULL OR now() < v_review_started + interval ''15 minutes'' THEN\n');
    EXECUTE v_definition;
  END IF;
END;
$migration$;
