/**
 * Composition. The only public entry point is evaluateProposal.
 *
 * Rules run in a fixed order, cheapest and most fundamental first, and the
 * first rejection wins. Ordering is deliberate: an agent that proposed a rate
 * to a carrier with revoked authority should be told about the authority, not
 * about the rate band, because the authority is what it must act on.
 */

import * as rules from "./rules.js";
import {
  assertNever,
  totalConsideration,
  type NegotiationSnapshot,
  type PolicyRejection,
  type PolicyResult,
  type Proposal,
} from "./types.js";

/**
 * Booking is not a negotiation round, so it never consumes a counter.
 *
 * Exhaustive switch on `proposal.kind`: adding a fourth proposal kind without
 * deciding whether it counts as a counter is a compile error via
 * `assertNever`, not a silent `false`.
 */
function decideCountsAsCounter(
  snapshot: NegotiationSnapshot,
  proposal: Proposal,
): boolean {
  switch (proposal.kind) {
    case "propose_rate":
    case "accept_counter":
      return rules.countsAsCounter(snapshot, proposal.linehaulCents);
    case "book_carrier":
      return false;
    default:
      return assertNever(proposal, "proposal kind");
  }
}

/**
 * Return a RateDecision or a PolicyRejection. Never throws for business
 * reasons, never mutates, never reads a clock, never touches I/O.
 *
 * `now` is a parameter so the same snapshot and proposal always produce the
 * same answer, which is what makes stored traces re-scorable.
 */
export function evaluateProposal(
  snapshot: NegotiationSnapshot,
  proposal: Proposal,
  now: Date,
): PolicyResult {
  const { accessorials } = proposal;
  const total = totalConsideration(proposal.linehaulCents, accessorials);

  const checks: readonly (PolicyRejection | null)[] = [
    // Can this action happen at all, from this state, with this carrier?
    rules.checkStateAllowsAction(snapshot, proposal),
    rules.checkAuthorityActive(snapshot, now),
    rules.checkEquipmentTypePermitted(snapshot),
    rules.checkWithinCapacity(snapshot),
    // Is the shape of the money legitimate?
    rules.checkAmountIsSane(proposal.linehaulCents),
    rules.checkAccessorialsApproved(accessorials),
    rules.checkAccessorialLimit(snapshot, accessorials),
    // Is the amount itself allowed?
    rules.checkWithinRateBand(snapshot, total),
    rules.checkCounterLimit(snapshot, proposal.linehaulCents),
    rules.checkMonotonicNonDecreasing(snapshot, total),
  ];

  for (const rejection of checks) {
    if (rejection !== null) {
      return rejection;
    }
  }

  return {
    approved: true,
    negotiationId: snapshot.negotiationId,
    linehaulCents: proposal.linehaulCents,
    accessorials,
    totalCents: total,
    countsAsCounter: decideCountsAsCounter(snapshot, proposal),
    newlyApprovedAccessorials: rules.newlyApproved(snapshot, accessorials),
  };
}
