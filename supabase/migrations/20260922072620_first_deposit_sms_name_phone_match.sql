-- Restore safe first-deposit matching for Orange SMS payloads where the
-- provider omits sender_number but embeds the sender phone in sender_name
-- (for example: "Customer Name-01234567890"). CRM is not yet guaranteed to
-- contain a first-time client, so the embedded phone is an explicit identity
-- signal and is compared by normalized last 10 digits.
DO $migration$
DECLARE
  v_definition text;
  v_marker text := $$      or (nullif(s.sender_number,'') is null$$;
  v_insert text := $body$      or (
          nullif(s.sender_number,'') is null
          and nullif(v_tx.sender_number,'') is not null
          and right(regexp_replace(coalesce(s.sender_name,''),'\D','','g'),10)
              = right(regexp_replace(v_tx.sender_number,'\D','','g'),10)
          and right(regexp_replace(coalesce(s.sender_name,''),'\D','','g'),10) <> ''
        )
$body$;
BEGIN
  select pg_get_functiondef('public.assign_unique_sms_to_maven_tx(bigint,integer)'::regprocedure)
    into v_definition;
  if v_definition is null then
    raise exception 'assign_unique_sms_to_maven_tx not found';
  end if;
  if position('first_deposit_embedded_phone_match' in v_definition) > 0 then
    return;
  end if;
  if position(v_marker in v_definition) = 0 then
    raise exception 'sender identity marker not found';
  end if;
  v_insert := replace(v_insert, 'or (', 'or ( /* first_deposit_embedded_phone_match */');
  -- The sender identity predicate appears in both candidate queries. Add the
  -- first-deposit fallback only to the primary candidate query; the reciprocal
  -- exclusion query must keep its stricter sender-number comparison.
  v_definition := regexp_replace(
    v_definition,
    v_marker,
    v_insert || E'\n' || v_marker,
    1,
    1
  );
  execute v_definition;
END;
$migration$;
