with classified as (
  select id,
    (regexp_match(coalesce(raw_sms, ''), '"sender"\s*:\s*"([^"]*)"'))[1] as embedded_sender,
    lower(concat_ws(' ', sender, sender_name, provider, sms_first_line, raw_sms, message)) as source_text
  from public.inbound_sms
)
update public.inbound_sms sms
set is_blocked = case
  when nullif(trim(coalesce(classified.embedded_sender, '')), '') is not null
    then not (lower(classified.embedded_sender) ~ 'orange\s*cash|orange cash|اورنچ|اورنج|vf[- ]?cash|vodafone\s*cash|فودافون|alex\s*bank|alexbank|بنك الاسكندرية|insta\s*pay|instapay|انستا ?باي|انستاباي')
  else not (classified.source_text ~ 'orange\s*cash|اورنچ\s*كاش|اورنج\s*كاش|vf[- ]?cash|vodafone\s*cash|فودافون\s*كاش|alex\s*bank|alexbank|بنك الاسكندرية|insta\s*pay|instapay|انستا ?باي|انستاباي')
end,
block_reason = case when sms.is_blocked then 'unsupported_sms_sender' else null end
from classified
where sms.id = classified.id;
