export type ProviderDecision = "PAID" | "DECLINED" | "EXPIRED" | "UNDERPAID" | "OVERPAID";

const AMOUNT_TOLERANCE = 0.009;

/**
 * Maven models a reduced amount on an already-paid transaction as
 * UNDERPAID. Keep this provider quirk in one pure function so execution and
 * verification cannot accidentally compare against different statuses.
 */
export function effectiveProviderDecision(
  requested: ProviderDecision,
  beforeStatus: string | null,
  providerAmount: number | null,
  overrideAmount?: number,
): ProviderDecision {
  return overrideAmount != null &&
      requested === "PAID" &&
      beforeStatus === "PAID" &&
      providerAmount != null &&
      overrideAmount < providerAmount
    ? "UNDERPAID"
    : requested;
}

/** A single verification rule for both normal responses and timeout recovery. */
export function providerStateMatches(
  status: unknown,
  amount: unknown,
  expectedStatus: ProviderDecision,
  expectedAmount?: number,
): boolean {
  if (String(status ?? "").toUpperCase() !== expectedStatus) return false;
  if (expectedAmount == null) return true;
  const actual = Number(amount);
  return Number.isFinite(actual) && Math.abs(actual - expectedAmount) <= AMOUNT_TOLERANCE;
}

/**
 * These failures are ambiguous: Maven may have committed the update before
 * the HTTP response was lost. They require a read-back, never an immediate
 * second write or a false worker_failed result.
 */
export function isAmbiguousProviderError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  return /timeout|timed out|abort|fetch failed|network|connection|socket|econn|http 5\d\d|unexpected end|unexpected token|invalid json/i.test(message);
}

/**
 * Automation must never reverse a terminal Maven decision merely because the
 * local mirror is late. In that case the provider is authoritative and the
 * worker should repair the mirror instead of producing an endless failure.
 */
export function shouldReconcileAutomationTerminal(
  actorName: string,
  providerStatus: string | null,
  requestedStatus: ProviderDecision,
): boolean {
  const terminal = new Set(["PAID", "DECLINED", "EXPIRED", "UNDERPAID", "OVERPAID"]);
  return /^automation-engine(?:-|$)/i.test(actorName) &&
    terminal.has(String(providerStatus ?? "").toUpperCase()) &&
    String(providerStatus).toUpperCase() !== requestedStatus;
}
