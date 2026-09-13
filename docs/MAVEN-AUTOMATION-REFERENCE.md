# OnTarget Maven Automation Reference

Updated: 2026-09-13
Timezone for operational reports: `Africa/Cairo`

This is the current V2 reference for the Maven pay-in approval flow. It replaces
older notes that described the legacy Supabase mirror as the source for Maven
transaction status.

## 1. Authority and data flow

| Layer | Responsibility |
| --- | --- |
| Maven portal | Authoritative provider status and provider transaction data |
| V2 Supabase (`iwhjmhazcvctvipoasct`) | Local operational read model, SMS links, decisions, audit history and queues |
| `maven-reconcile-final-status` | Direct Maven → V2 reconciliation |
| Playwright/Railway worker | Executes approve/decline actions that require Maven browser JavaScript |
| OnTarget panel | Operator review, reporting and monitoring |

Maven deposits and payouts are no longer copied from the old Supabase project.
The legacy delta mirror is limited to non-Maven support data such as inbound SMS,
CRM, blacklist and wallet-device configuration.

## 2. Core V2 tables

- `maven_transactions`: one row per Maven pay-in transaction. Provider fields
  include `status`, `amount`, `merchant`, `sender_number`, `created_utc`,
  `modified_utc`, `last_seen_at` and `guid`. Local fields include `approved_by`,
  `paid_source`, `needs_review`, `row_hash` and `reconciled_from_provider`.
- `maven_payout_transactions`: Maven payout read model and SMS assignment state.
- `inbound_sms`: one row per Android-forwarded SMS, including provider, amount,
  wallet/device identity, `received_at`, `balance_after` and match metadata.
- `review_queue`: decision-engine evaluation and manual-review state.
- `browser_jobs`: execution queue for the browser worker. Valid terminal state is
  `completed`, not `done`.
- `browser_worker_status`: worker heartbeat and watchdog input.
- `automation_rules_scoped`: global, merchant and account-scoped rules.
- `automation_settings`: global kill switches, including Maven and automation.
- `manual_decisions`: insert-only operator/Telegram decisions.
- `maven_transaction_history`: status history, including reconciliation changes.
- `maven_reconcile_runs`: provider reconciliation metrics, errors and duration.
- `audit_log`: immutable operational audit events.

## 3. Direct Maven reconciliation

Edge Function: `maven-reconcile-final-status` (V2, active version 3)

- Live mode reads a precise 15-minute overlap window.
- Repair mode reads the last 48 hours.
- Maven date ranges are sent with exact timestamps; they are not expanded to an
  entire calendar day.
- Provider-owned columns are updated through an allowlist only.
- Local SMS links, operator identity, notes, manual fields and audit metadata are
  preserved.
- A changed status creates rows in `maven_transaction_history` and `audit_log`.
- `PAID → non-PAID` is marked `needs_review` instead of being silently accepted.
- Every run is recorded in `maven_reconcile_runs`.

Vercel routes:

- `/api/cron/delta-sync`: live Maven reconcile plus the fast legacy SMS mirror.
- `/api/cron/delta-sync-full`: 48-hour Maven repair plus the non-Maven legacy repair.
- `/api/cron/auto-decline`: V2 decline sweep, subject to automation switches.

The live cron is scheduled every minute; the repair cron is scheduled every ten
minutes. The browser panel also requests the live route while open, throttled by
the distributed lease.

## 4. Decision engine and matching

The database functions remain the authority for matching and decision policy:

- `evaluate_transaction_for_auto_decision`
- `check_balance_continuity`
- `resolve_automation_rule`
- `sweep_auto_decline_stale_unmatched`
- `backfill_unevaluated_pending_maven`
- `audit_missing_maven_transactions`
- `claim_next_browser_job`
- `complete_browser_job`
- `fail_browser_job`
- `release_stale_browser_jobs`
- `apply_manual_decision`

Required safety behavior:

1. Exact phone + amount + provider match may be approved immediately when the
   applicable rule allows it.
2. A unique amount/name/balance-continuity match can be evaluated without waiting
   for a phone number when the provider format does not include one.
3. Two or more plausible SMS candidates are ambiguous and must go to manual
   review, never silent decline.
4. A late SMS must re-evaluate a pending review immediately through the SMS
   trigger, not wait for the next broad sweep.
5. Balance continuity is scoped by the physical wallet identifier
   (`webhook_name`/device), never by a shared unknown bucket.
6. Every browser-job creator must be idempotent and must check for an existing
   open job or already-decided transaction.
7. A worker job is completed only when Maven's resulting status equals its target.

## 5. Execution worker

Maven approve/decline is browser-based. Direct HTTP attempts returned Maven's
own error page, so the Railway Playwright worker remains required.

Worker requirements:

- Poll `browser_jobs`; do not rely on pushed execution.
- Claim with row locking / `SKIP LOCKED` semantics.
- Heartbeat in `browser_worker_status`.
- Re-queue stale `running` jobs with the reaper.
- Mark a vanished or expired transaction `EXPIRED_LOCAL` only after the retry
  policy verifies it is no longer actionable.
- Never interpret “not PENDING” as proof that the requested action succeeded.

## 6. Current policy switches

Before changing production behavior, inspect `automation_settings` and the
merchant/account-scoped rules. The important switches are:

- `maven_enabled`
- `ngpay_enabled`
- `automation_enabled`
- `balance_check_enabled`
- `above_limit_to_manual`

Policy thresholds and grace periods must be read from the live database rather
than hard-coded in this document. The currently deployed decline route uses the
V2 sweep and does not use the legacy auto-decline bridge unless the explicit
`ENABLE_LEGACY_AUTO_DECLINE_BRIDGE` server flag is enabled.

## 7. Telegram / n8n review channel

n8n may format and deliver manual-review cards, and a Telegram action may insert
into `manual_decisions`. It must not execute Maven actions over plain HTTP.
The database manual-decision function must re-check whether automation already
decided before creating a competing `browser_jobs` row.

Watchdog requirements:

- Alert when `worker-1` has no heartbeat for more than the configured threshold.
- Show pending, running, failed and needs-review queue counts.
- Show target-vs-actual mismatches for completed jobs.

## 8. Incident checklist

When Maven and the panel disagree:

1. Compare Maven's visible transaction ID/status with `maven_transactions`.
2. Check `maven_reconcile_runs` for the latest successful window and error.
3. Confirm `reconciled_from_provider` and `last_seen_at`.
4. Check `maven_transaction_history` and `audit_log` before changing a status.
5. Check `inbound_sms` for an existing SMS link before manual assignment.
6. If Maven confirms a stuck transaction was paid, use the panel/manual decision
   path so the correction is recorded as `manual_edit`, with actor `Maven Team`.
7. Never create a fake SMS or mark an unverified provider action completed.

## 9. Safe change procedure

- Test a decision function against a real historical `tx_id` before editing it.
- Execute every new sweep once manually before scheduling it.
- Clean up test queue rows immediately.
- Check all callers when changing a function return column.
- Verify the exact state values allowed by table constraints.
- Check RLS and least-privilege policies before adding a new dashboard RPC.

