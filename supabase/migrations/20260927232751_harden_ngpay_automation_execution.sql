-- The automation evaluator dispatches ngpay-approve through pg_net. Production
-- traces showed frequent "Timeout of 5000 ms reached" responses while healthy
-- Maven executions normally take 3-5 seconds. An implicit/default timeout is
-- therefore too short and leaves real transactions PENDING until a later retry.
--
-- Patch every dispatch site in the current function definition rather than
-- copying the large evaluator body here; this preserves the safety rules added
-- by later migrations while making the transport timeout explicit.
do $migration$
declare
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef('public.evaluate_and_dispatch_ngpay_decision_core(bigint)'::regprocedure)
    into v_definition;

  if position('timeout_milliseconds := 30000' in v_definition) = 0 then
    v_patched := replace(
      v_definition,
      E'\n    ) into v_request_id;',
      E',\n      timeout_milliseconds := 30000\n    ) into v_request_id;'
    );

    if v_patched = v_definition then
      raise exception 'ngpay automation dispatch sites were not found';
    end if;

    execute v_patched;
  end if;
end
$migration$;

comment on function public.evaluate_and_dispatch_ngpay_decision_core(bigint) is
  'Evaluates NGPay automation rules and dispatches provider execution with an explicit 30-second pg_net timeout.';

-- Production had two one-minute jobs dispatching PAID for the same linked SMS
-- transaction. The primary evaluator already has a global approval rule and
-- performs the stricter blocked/duplicate/amount/wallet/SMS checks. The
-- priority job bypassed those checks and raced the primary worker, producing
-- duplicate decision logs and concurrent Maven writes. Retire only that
-- redundant job; automation-ngpay-sweep remains active every minute.
do $migration$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'automation-priority-approve-linked'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
end
$migration$;
