create or replace function public.prevent_sms_reassignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.consumed_by_tx_id is not null
     and new.consumed_by_tx_id is not null
     and new.consumed_by_tx_id <> old.consumed_by_tx_id then
    raise exception using errcode = '23505', message = 'sms_already_linked_to_transaction';
  end if;
  if new.consumed_by_tx_id is not null
     and exists (select 1 from public.inbound_sms s where s.id <> new.id and s.consumed_by_tx_id = new.consumed_by_tx_id) then
    raise exception using errcode = '23505', message = 'transaction_already_linked_to_sms';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inbound_sms_link_exclusivity on public.inbound_sms;
create trigger trg_inbound_sms_link_exclusivity
before update of consumed_by_tx_id on public.inbound_sms
for each row execute function public.prevent_sms_reassignment();
