-- Returning clients with a proven paid history get a 10-minute SMS grace
-- window. The normal engine remains unchanged at its configured (normally
-- five-minute) grace for new clients and all other transactions.
DO $migration$
DECLARE
  v_definition text;
  v_marker text := '    IF v_linked_sms THEN';
  v_insert text := $body$
    -- A retained client is identified by CRM history plus real linked SMS
    -- evidence. This deliberately uses the sender phone only; names/emails
    -- are not stable payment identities.
    IF EXISTS (
      SELECT 1
      FROM public.crm_clients c
      WHERE regexp_replace(coalesce(c.normalized_phone, c.phone_no, ''), '\D', '', 'g')
          = regexp_replace(coalesce(r.sender_number, ''), '\D', '', 'g')
        AND coalesce(c.is_repeat_client, false)
        AND coalesce(c.approved_transactions, 0) > 0
        AND coalesce(c.approved_transactions, 0) > coalesce(c.declined_transactions, 0)
        AND (
          SELECT count(*)
          FROM public.inbound_sms s
          JOIN public.maven_transactions paid_tx ON paid_tx.tx_id = s.consumed_by_tx_id
          WHERE regexp_replace(coalesce(paid_tx.sender_number, ''), '\D', '', 'g')
              = regexp_replace(coalesce(r.sender_number, ''), '\D', '', 'g')
            AND paid_tx.status IN ('PAID', 'APPROVED')
        ) > coalesce(c.declined_transactions, 0)
        AND r.created_utc::timestamptz > now() - interval '10 minutes'
    ) THEN
      UPDATE public.review_queue
      SET decision_reason = 'Retained client with paid SMS history — 10-minute SMS grace window'
      WHERE id = r.review_id;
      out_tx_id := r.row_tx_id; declined := false;
      note := 'retained client; extended SMS grace'; RETURN NEXT; CONTINUE;
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
