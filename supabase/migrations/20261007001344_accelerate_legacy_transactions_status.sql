-- The legacy public.transactions compatibility view exposes lower(status).
-- Some still-connected clients filter that view by status, so PostgreSQL
-- cannot use the plain maven_transactions(status) index and repeatedly scans
-- the full ledger. Match the view expression to keep those reads indexed.
create index if not exists maven_transactions_lower_status_idx
  on public.maven_transactions (lower(status));
