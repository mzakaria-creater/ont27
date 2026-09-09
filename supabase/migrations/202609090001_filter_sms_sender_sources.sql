-- Only provider inbox messages are financial evidence for the panel.
-- Some forwarders label the provider column as orange-cash even when the
-- actual SMS sender is a customer phone number; inspect the embedded sender
-- first so those messages cannot enter the matching flow.
create or replace function public.mark_supported_sms_source()
returns trigger
language plpgsql
as $$
declare
  embedded_sender text;
  source_text text;
begin
  embedded_sender := (regexp_match(coalesce(new.raw_sms, ''), '"sender"\s*:\s*"([^"]*)"'))[1];
  source_text := lower(concat_ws(' ', new.sender, new.sender_name, new.provider, new.sms_first_line, new.raw_sms, new.message));
  if nullif(trim(coalesce(embedded_sender, '')), '') is not null then
    new.is_blocked := not (lower(embedded_sender) ~ 'orange\s*cash|orange cash|اورنچ|اورنج|vf[- ]?cash|vodafone\s*cash|فودافون|alex\s*bank|alexbank|بنك الاسكندرية|insta\s*pay|instapay|انستا ?باي|انستاباي');
  elsif source_text ~ 'orange\s*cash|اورنچ\s*كاش|اورنج\s*كاش|vf[- ]?cash|vodafone\s*cash|فودافون\s*كاش|alex\s*bank|alexbank|بنك الاسكندرية|insta\s*pay|instapay|انستا ?باي|انستاباي' then
    -- Preserve an intentional operator block for an allowed source.
    new.is_blocked := coalesce(new.is_blocked, false);
  else
    new.is_blocked := true;
  end if;
  if new.is_blocked then new.block_reason := 'unsupported_sms_sender'; end if;
  return new;
end;
$$;

drop trigger if exists trg_mark_supported_sms_source on public.inbound_sms;
create trigger trg_mark_supported_sms_source
before insert or update of sender, sender_name, provider, sms_first_line, raw_sms, message
on public.inbound_sms
for each row execute function public.mark_supported_sms_source();

update public.inbound_sms
set is_blocked = true, block_reason = 'unsupported_sms_sender'
where id = 15657;
