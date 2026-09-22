-- Roll back the identity-update recheck trigger. The existing INSERT and SMS
-- update triggers remain active; this trigger could contend with the panel's
-- manual SMS-link transaction while it updates the receiving wallet.
DROP TRIGGER IF EXISTS trg_recheck_pending_transaction_identity ON public.maven_transactions;
