-- Add explicit Cairo-local date range support to the performance dashboard.
-- The existing function remains unchanged for the rolling-window view.
do $block$
declare
  definition text;
begin
  select pg_get_functiondef(p.oid)
    into definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'panel_performance_slice'
    and pg_get_function_identity_arguments(p.oid) = 'p_dimension text, p_gateway text, p_days numeric, p_bucket text';

  if definition is null then
    raise exception 'public.panel_performance_slice(text,text,numeric,text) is required';
  end if;

  definition := replace(
    definition,
    'public.panel_performance_slice(p_dimension text DEFAULT ''payment_method''::text, p_gateway text DEFAULT ''NagupayP2P''::text, p_days numeric DEFAULT 7, p_bucket text DEFAULT ''day''::text)',
    'public.panel_performance_slice_range(p_dimension text DEFAULT ''payment_method''::text, p_gateway text DEFAULT ''NagupayP2P''::text, p_days numeric DEFAULT 7, p_bucket text DEFAULT ''day''::text, p_from timestamptz DEFAULT null, p_to timestamptz DEFAULT null)'
  );
  definition := replace(
    definition,
    'v_to timestamptz := now(); v_from timestamptz;',
    'v_to timestamptz := coalesce(p_to, now()); v_from timestamptz;'
  );
  definition := replace(
    definition,
    'v_from := v_to - make_interval(secs => (v_days * 86400)::double precision);',
    'v_from := coalesce(p_from, v_to - make_interval(secs => (v_days * 86400)::double precision));'
  );
  execute definition;
end
$block$;
