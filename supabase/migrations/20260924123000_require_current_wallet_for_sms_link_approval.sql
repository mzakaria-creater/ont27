-- A historical receiving_wallet is not enough for irreversible approval.
-- Instant SMS-link approval now requires the SMS wallet to match Maven's
-- current to_account_number as well as the sender number.
CREATE OR REPLACE FUNCTION public.trg_approve_on_sms_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_tx public.maven_transactions%rowtype;
  v_already_declined boolean;
  v_service_key text;
  v_sms_wallet text;
begin
  if new.consumed_by_tx_id is null or old.consumed_by_tx_id is not null then
    return new;
  end if;

  select * into v_tx from public.maven_transactions where tx_id = new.consumed_by_tx_id;
  if v_tx.tx_id is null or v_tx.status is distinct from 'PENDING' or v_tx.gateway is distinct from 'NagupayP2P' then
    return new;
  end if;

  if coalesce(v_tx.payment_method, '') ~* 'walid[[:space:]]+company[[:space:]]+ltd' then
    return new;
  end if;

  v_sms_wallet := coalesce(nullif(new.confirmed_wallet_number,''), nullif(new.wallet_number,''), nullif(new.receiver_number,''));

  -- Strong instant approval requires current wallet and sender identity on
  -- both sides. A missing current wallet or a historical-wallet-only match is
  -- review evidence, never an irreversible provider decision.
  if nullif(new.sender_number,'') is null
     or nullif(v_tx.sender_number,'') is null
     or regexp_replace(new.sender_number,'\D','','g') <> regexp_replace(v_tx.sender_number,'\D','','g')
     or nullif(v_sms_wallet,'') is null
     or nullif(v_tx.to_account_number,'') is null
     or regexp_replace(v_sms_wallet,'\D','','g') <> regexp_replace(v_tx.to_account_number,'\D','','g')
  then
    return new;
  end if;

  select exists (
    select 1 from public.deposit_decision_log l
    where l.tx_id = v_tx.tx_id
      and l.reason ilike '%Live provider status is DECLINED%refusing reversal%'
  ) into v_already_declined;

  if v_already_declined then
    update public.maven_transactions set status='DECLINED', last_status_change=now()
      where tx_id = v_tx.tx_id and status='PENDING';
    return new;
  end if;

  select decrypted_secret into v_service_key from vault.decrypted_secrets where name='daily_report_service_key';
  if v_service_key is null then return new; end if;

  perform net.http_post(
    url := 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/ngpay-approve',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key),
    body := jsonb_build_object(
      'tx_id', v_tx.tx_id, 'decision', 'PAID', 'actor_name', 'automation-engine-instant',
      'remark', 'Instant approval on SMS link event (current wallet and sender confirmed match)'
    ),
    timeout_milliseconds := 15000
  );

  return new;
end;
$function$;
