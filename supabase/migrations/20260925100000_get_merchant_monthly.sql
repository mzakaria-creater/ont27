-- Monthly merchant volume aggregate for the "Merchant Monthly Volume" report.
-- SECURITY INVOKER (the default — no SECURITY DEFINER clause) so it runs
-- with the caller's own RLS, matching every other reporting RPC in this
-- schema (e.g. payment_link_analytics).
--
-- Fee lookup: v_merchant_daily_cairo.merchant is a display name that lines
-- up with merchants.name; merchants.master_merchant_id then points at
-- master_merchant_fee_defaults.master_merchant_id (a grouping id that is
-- NOT the same table as master_merchants — verified against live data).
-- Only payin_commission_pct maps to anything here (it's the deposit-side
-- rate); the schema has no per-merchant settlement-fee override, so that
-- side is always the flat 6% fallback.
create or replace function public.get_merchant_monthly(
  p_merchants text[] default null,
  p_from date default null,
  p_to date default null
)
returns table (
  merchant text,
  month date,
  paid_n bigint,
  paid_amt numeric,
  declined_n bigint,
  declined_amt numeric,
  deposit_fee_rate numeric,
  settlement_fee_rate numeric,
  deposit_fee_egp numeric,
  settlement_fee_egp numeric,
  net_egp numeric,
  first_day date,
  last_day date,
  is_current_month boolean,
  partial_month boolean,
  gap_dates date[],
  undated_n bigint
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with bounds as (
    select
      coalesce(p_from, (date_trunc('month', (now() at time zone 'Africa/Cairo')) - interval '5 months')::date) as d_from,
      coalesce(p_to, (now() at time zone 'Africa/Cairo')::date) as d_to
  ),
  daily as (
    select v.merchant, v.day_cairo, v.paid_n, v.paid_amt, v.declined_n, v.declined_amt
    from public.v_merchant_daily_cairo v, bounds b
    where v.day_cairo is not null
      and v.merchant is not null
      and v.day_cairo between b.d_from and b.d_to
      and (p_merchants is null or v.merchant = any(p_merchants))
  ),
  undated as (
    select v.merchant, sum(coalesce(v.paid_n, 0) + coalesce(v.declined_n, 0) + coalesce(v.other_n, 0)) as undated_n
    from public.v_merchant_daily_cairo v
    where v.day_cairo is null
      and v.merchant is not null
      and (p_merchants is null or v.merchant = any(p_merchants))
    group by v.merchant
  ),
  monthly as (
    select
      merchant,
      date_trunc('month', day_cairo)::date as month,
      sum(paid_n) as paid_n,
      sum(paid_amt) as paid_amt,
      sum(declined_n) as declined_n,
      sum(declined_amt) as declined_amt,
      min(day_cairo) as first_day,
      max(day_cairo) as last_day
    from daily
    group by merchant, date_trunc('month', day_cairo)
  ),
  -- One calendar row per day of each merchant-month, clipped to the
  -- requested range (so a future tail of the current month never counts
  -- as a "gap"), used only to find runs of zero-paid days.
  cal as (
    select m.merchant, m.month, gs::date as d
    from monthly m, bounds b
    cross join lateral generate_series(m.month, (m.month + interval '1 month - 1 day')::date, interval '1 day') as gs
    where gs::date between b.d_from and b.d_to
  ),
  cal_paid as (
    select c.merchant, c.month, c.d, coalesce(d.paid_n, 0) as paid_n
    from cal c
    left join daily d on d.merchant = c.merchant and d.day_cairo = c.d
  ),
  -- Classic gaps-and-islands: within each zero/non-zero run, consecutive
  -- dates share (date - row_number), so grouping by that collapses each
  -- run to one row.
  runs as (
    select
      merchant, month, d, paid_n,
      (paid_n = 0) as is_zero,
      d - (row_number() over (partition by merchant, month, (paid_n = 0) order by d))::int as grp
    from cal_paid
  ),
  gap_groups as (
    select merchant, month, grp, array_agg(d order by d) as gdates
    from runs
    where is_zero
    group by merchant, month, grp
    having count(*) >= 5
  ),
  gaps as (
    select merchant, month, array_agg(gd order by gd) as gap_dates
    from gap_groups, unnest(gdates) as gd
    group by merchant, month
  ),
  fee_rates as (
    select
      mo.merchant, mo.month,
      coalesce(fd.payin_commission_pct, 5.5) / 100.0 as deposit_fee_rate,
      0.06::numeric as settlement_fee_rate
    from monthly mo
    left join public.merchants me on me.name = mo.merchant
    left join public.master_merchant_fee_defaults fd on fd.master_merchant_id = me.master_merchant_id
  ),
  calc as (
    select
      mo.*,
      fr.deposit_fee_rate,
      fr.settlement_fee_rate,
      round(mo.paid_amt * fr.deposit_fee_rate, 2) as deposit_fee_egp,
      round((mo.paid_amt - mo.paid_amt * fr.deposit_fee_rate) * fr.settlement_fee_rate, 2) as settlement_fee_egp
    from monthly mo
    join fee_rates fr on fr.merchant = mo.merchant and fr.month = mo.month
  )
  select
    c.merchant,
    c.month,
    c.paid_n,
    c.paid_amt,
    c.declined_n,
    c.declined_amt,
    c.deposit_fee_rate,
    c.settlement_fee_rate,
    c.deposit_fee_egp,
    c.settlement_fee_egp,
    round(c.paid_amt - c.deposit_fee_egp - c.settlement_fee_egp, 2) as net_egp,
    c.first_day,
    c.last_day,
    (c.month = date_trunc('month', (now() at time zone 'Africa/Cairo'))::date) as is_current_month,
    (
      c.first_day <> c.month
      or (
        c.month <> date_trunc('month', (now() at time zone 'Africa/Cairo'))::date
        and c.last_day <> (c.month + interval '1 month - 1 day')::date
      )
    ) as partial_month,
    coalesce(g.gap_dates, '{}'::date[]) as gap_dates,
    coalesce(u.undated_n, 0) as undated_n
  from calc c
  left join gaps g on g.merchant = c.merchant and g.month = c.month
  left join undated u on u.merchant = c.merchant
  order by c.merchant, c.month;
$function$;

grant execute on function public.get_merchant_monthly(text[], date, date) to authenticated;
