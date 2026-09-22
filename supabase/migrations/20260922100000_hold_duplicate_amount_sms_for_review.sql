-- Hold ambiguous same-amount SMS candidates instead of silently taking an
-- action. Operators can inspect the highlighted SMS and assign it manually.
DO $migration$
DECLARE
  v_definition text;
  v_old text := '  if v_candidate_count <> 1 then return null; end if;';
  v_new text := $body$  if v_candidate_count <> 1 then
    if v_candidate_count > 1 then
      update public.inbound_sms
      set review_required=true,
          match_status='review_hold_duplicate_amount_time',
          notes=concat_ws('; ', nullif(notes,''), 'held_for_manual_review_duplicate_amount_within_time_window'),
          processed_at=coalesce(processed_at, now())
      where id=v_sms_id and consumed_by_tx_id is null;
    end if;
    return null;
  end if;$body$;
BEGIN
  select pg_get_functiondef('public.assign_unique_sms_to_maven_tx(bigint,integer)'::regprocedure)
    into v_definition;
  if v_definition is null then
    raise exception 'assign_unique_sms_to_maven_tx not found';
  end if;
  if position('review_hold_duplicate_amount_time' in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'candidate-count guard not found';
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
END;
$migration$;
