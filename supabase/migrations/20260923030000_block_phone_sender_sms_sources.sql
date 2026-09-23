-- A scam SMS can copy Orange/Vodafone wording while its actual From header is
-- a phone number (for example: `From : +201200793615()`). Such messages are
-- not network-provider evidence and must never enter automation or Live SMS.
create or replace function public.mark_supported_sms_source()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  embedded_sender text;
  source_text text;
  phone_sender_header boolean;
begin
  phone_sender_header := coalesce(new.sms_first_line, '') ~* '^\s*from\s*:\s*\+?[0-9][0-9 -]{7,}';
  embedded_sender := (regexp_match(coalesce(new.raw_sms, ''), '"sender"\s*:\s*"([^"]*)"'))[1];
  source_text := lower(concat_ws(' ', new.sender, new.sender_name, new.provider, new.sms_first_line, new.raw_sms, new.message));

  if phone_sender_header then
    new.is_blocked := true;
  elsif nullif(trim(coalesce(embedded_sender, '')), '') is not null then
    new.is_blocked := not (lower(embedded_sender) ~ 'orange\s*cash|orange cash|اورنچ|اورنج|vf[- ]?cash|vodafone\s*cash|فودافون|alex\s*bank|alexbank|بنك الاسكندرية|insta\s*pay|instapay|انستا ?باي|انستاباي');
  elsif source_text ~ 'orange\s*cash|اورنچ\s*كاش|اورنج\s*كاش|vf[- ]?cash|vodafone\s*cash|فودافون\s*كاش|alex\s*bank|alexbank|بنك الاسكندرية|insta\s*pay|instapay|انستا ?باي|انستاباي' then
    new.is_blocked := coalesce(new.is_blocked, false);
  else
    new.is_blocked := true;
  end if;

  if new.is_blocked then new.block_reason := 'unsupported_sms_sender'; end if;
  return new;
end;
$$;

update public.inbound_sms
set is_blocked = true, block_reason = 'unsupported_sms_sender'
where id in (1002263, 1002272)
   or coalesce(sms_first_line, '') ~* '^\s*from\s*:\s*\+?[0-9][0-9 -]{7,}';
