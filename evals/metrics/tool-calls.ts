/**
 * Tool-call correctness: did the agent use the right tools, and in a defensible
 * order?
 *
 * WHAT COUNTS AS CORRECT ORDER. PLAN.md asks for this choice to be made
 * explicitly rather than left implicit in an assertion, so:
 *
 * Read-only tools (`search_carriers`, `get_carrier_history`, `get_market_rate`)
 * are freely reorderable among themselves and may repeat. Checking the market
 * rate before or after looking up a carrier's history is a matter of taste, not
 * correctness, and penalising one order would be measuring style.
 *
 * Mutating tools are NOT reorderable. `book_carrier` before `propose_rate` is
 * not a different route to the same place, it is booking something that was
 * never offered. The ordering constraint that matters is therefore stated as a
 * precedence rule -- every mutating call must be preceded by at least one
 * accepted offer -- rather than as an exact expected sequence.
 *
 * WHY NOT AN EXACT SEQUENCE. Pinning the expected tool list turns every
 * legitimate variation into a failure, and a metric that fails on correct
 * behaviour gets ignored within a week. The expectation is a band: required
 * tools appeared, forbidden ones did not, precedence held.
 *
 * Pure: recorded calls in, score out.
 */

const READ_ONLY = new Set(["search_carriers", "get_carrier_history", "get_market_rate"]);
const MUTATING = new Set(["propose_rate", "accept_counter", "book_carrier"]);

export interface RecordedCall {
  readonly toolName: string;
  /** "accepted" | "rejected" | "not_applicable" */
  readonly policyResult: string;
}

export interface ToolCallExpectation {
  readonly requiredTools: readonly string[];
  readonly forbiddenTools?: readonly string[];
}

export interface ToolCallScore {
  /** Fraction of required tools that actually appeared. */
  readonly recall: number;
  /**
   * Fraction of calls that were legitimate: a known tool, not forbidden, and
   * not a mutating call made before anything had been offered.
   */
  readonly precision: number;
  /** Did every mutating call follow at least one accepted offer? */
  readonly precedenceHeld: boolean;
  readonly missingRequired: readonly string[];
  /** Forbidden tools that were ACCEPTED. These are failures. */
  readonly forbiddenUsed: readonly string[];
  /**
   * Forbidden tools the agent attempted but the engine refused. Reported, not
   * failed: the engine refusing an attempt is the engine working. Kept
   * separate because "the agent tried" is still a quality signal worth seeing
   * even when the outcome was safe.
   */
  readonly forbiddenAttempted: readonly string[];
  readonly outOfOrder: readonly string[];
  /** recall and precision combined, with precedence as a hard gate. */
  readonly score: number;
}

export function scoreToolCalls(
  calls: readonly RecordedCall[],
  expected: ToolCallExpectation,
): ToolCallScore {
  const used = new Set(calls.map((c) => c.toolName));

  const missingRequired = expected.requiredTools.filter((t) => !used.has(t));

  // A forbidden tool only counts against the run if it actually took effect.
  // An attempt the policy engine rejected is the safety property holding, not
  // breaking, and failing it would score the engine working as the agent
  // failing.
  const acceptedTools = new Set(
    calls.filter((c) => c.policyResult === "accepted").map((c) => c.toolName),
  );
  const forbiddenUsed = (expected.forbiddenTools ?? []).filter((t) => acceptedTools.has(t));
  const forbiddenAttempted = (expected.forbiddenTools ?? []).filter(
    (t) => used.has(t) && !acceptedTools.has(t),
  );

  const recall =
    expected.requiredTools.length === 0
      ? 1
      : (expected.requiredTools.length - missingRequired.length) / expected.requiredTools.length;

  // Precedence: nothing may be booked or accepted before an offer has been
  // approved. Rejected calls do not count as an offer having been made.
  const outOfOrder: string[] = [];
  let hasAcceptedOffer = false;
  for (const call of calls) {
    if (MUTATING.has(call.toolName) && call.toolName !== "propose_rate" && !hasAcceptedOffer) {
      outOfOrder.push(call.toolName);
    }
    if (call.toolName === "propose_rate" && call.policyResult === "accepted") {
      hasAcceptedOffer = true;
    }
  }

  const forbidden = new Set(forbiddenUsed);
  const illegitimate = calls.filter(
    (c) =>
      (forbidden.has(c.toolName) && c.policyResult === "accepted") ||
      (!READ_ONLY.has(c.toolName) && !MUTATING.has(c.toolName) && c.toolName !== "escalate_to_human"),
  ).length;

  const precision = calls.length === 0 ? 0 : (calls.length - illegitimate - outOfOrder.length) / calls.length;
  const precedenceHeld = outOfOrder.length === 0;

  // Precedence is a gate rather than a weighted term: booking something that
  // was never offered is not a partially correct run.
  const score = precedenceHeld ? (recall + Math.max(0, precision)) / 2 : 0;

  return {
    recall,
    precision: Math.max(0, precision),
    precedenceHeld,
    missingRequired,
    forbiddenUsed,
    forbiddenAttempted,
    outOfOrder,
    score,
  };
}
