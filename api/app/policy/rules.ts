/**
 * One rule per function. Each is pure, individually testable, individually
 * explainable, and returns a PolicyRejection or null.
 *
 * Kept separate rather than folded into one validator so that a rejection can
 * name exactly which rule bound and why, and so a reviewer can read any single
 * rule without holding the others in their head.
 */

import {
  CAPACITY_LBS,
  isTypePermitted,
  isWithinCapacity,
  type Equipment,
} from "../domain/equipment.js";
import type { NegotiationState } from "../domain/negotiation.js";
import {
  ACCESSORIAL_CODES,
  MAX_ACCESSORIAL_APPROVALS,
  MAX_COUNTERS,
  PROPOSAL_LABELS,
  rejection,
  type Accessorial,
  type AccessorialCode,
  type Cents,
  type NegotiationSnapshot,
  type PolicyRejection,
  type Proposal,
} from "./types.js";

/**
 * Money for humans. Hand-rolled rather than `toLocaleString`, which depends on
 * whatever ICU data the runtime happens to ship. A module whose entire selling
 * point is that a stored trace re-scores identically should not have its
 * output vary with a Node build.
 */
function usd(amount: number): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const dollars = Math.floor(abs / 100);
  const remainder = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${group(dollars)}.${remainder}`;
}

function group(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Which actions each state permits. The full transition table is state/'s job;
 * this is only the question "may this action be attempted from here at all".
 *
 * `satisfies Record<NegotiationState, ...>` means a new state cannot be added
 * without deciding what it permits, at compile time.
 */
const ACTIONS_BY_STATE = {
  NEW: new Set<Proposal["kind"]>(["propose_rate"]),
  CARRIER_CONTACTED: new Set<Proposal["kind"]>(["propose_rate"]),
  WAITING_FOR_RESPONSE: new Set<Proposal["kind"]>(["propose_rate", "accept_counter"]),
  NEGOTIATING: new Set<Proposal["kind"]>(["propose_rate", "accept_counter"]),
  AGREED: new Set<Proposal["kind"]>(["book_carrier"]),
  BOOKING: new Set<Proposal["kind"]>(["book_carrier"]),
  BOOKED: new Set<Proposal["kind"]>(),
  ESCALATED: new Set<Proposal["kind"]>(),
  FAILED: new Set<Proposal["kind"]>(),
} as const satisfies Record<NegotiationState, ReadonlySet<Proposal["kind"]>>;

export function checkStateAllowsAction(
  snapshot: NegotiationSnapshot,
  proposal: Proposal,
): PolicyRejection | null {
  if (ACTIONS_BY_STATE[snapshot.state].has(proposal.kind)) {
    return null;
  }
  const label = PROPOSAL_LABELS[proposal.kind];
  return rejection(
    "state_forbids_action",
    `Negotiation is in state ${snapshot.state}, which does not permit ${label}.`,
    { state: snapshot.state, action: label },
  );
}

/**
 * Checked on every mutating action, not only at booking.
 *
 * A negotiation can run for hours. Authority granted at the opening offer may
 * be revoked before the booking, which is why invariant 6 requires validating
 * twice rather than trusting an earlier check.
 */
export function checkAuthorityActive(
  snapshot: NegotiationSnapshot,
  now: Date,
): PolicyRejection | null {
  const { carrier } = snapshot;
  const expired =
    carrier.authorityExpiresAt !== null && now.getTime() >= carrier.authorityExpiresAt.getTime();
  if (carrier.authorityActive && !expired) {
    return null;
  }
  return rejection(
    "authority_inactive",
    `Carrier ${carrier.carrierId} does not hold active operating authority. ` +
      "A load cannot be tendered to a carrier without it.",
    { carrier_id: carrier.carrierId },
  );
}

function usableTrailers(snapshot: NegotiationSnapshot): {
  typeOk: Equipment[];
  bothOk: Equipment[];
} {
  const { load } = snapshot;
  const typeOk = snapshot.carrier.equipment.filter((e) => isTypePermitted(load.equipment, e));
  const bothOk = typeOk.filter((e) => isWithinCapacity(e, load.weightLbs));
  return { typeOk, bothOk };
}

/** Can any trailer this carrier owns legally and safely haul this freight. */
export function checkEquipmentTypePermitted(
  snapshot: NegotiationSnapshot,
): PolicyRejection | null {
  const { typeOk } = usableTrailers(snapshot);
  if (typeOk.length > 0) {
    return null;
  }
  const owned = snapshot.carrier.equipment.join(", ");
  return rejection(
    "equipment_type_not_permitted",
    `Load ${snapshot.load.loadId} requires ${snapshot.load.equipment}; ` +
      `carrier ${snapshot.carrier.carrierId} operates ${owned}.`,
    { required: snapshot.load.equipment, owned },
  );
}

/**
 * Separate from type compatibility: different data, different failure.
 *
 * A reefer may haul dry freight and still be too light for it. One rule
 * passing tells you nothing about the other.
 */
export function checkWithinCapacity(snapshot: NegotiationSnapshot): PolicyRejection | null {
  const { typeOk, bothOk } = usableTrailers(snapshot);
  // An empty typeOk is left to the type rule, which reports it better.
  if (bothOk.length > 0 || typeOk.length === 0) {
    return null;
  }
  const best = Math.max(...typeOk.map((e) => CAPACITY_LBS[e]));
  return rejection(
    "exceeds_trailer_capacity",
    `Load ${snapshot.load.loadId} weighs ${group(snapshot.load.weightLbs)} lbs; ` +
      `the heaviest suitable trailer carrier ${snapshot.carrier.carrierId} ` +
      `operates caps at ${group(best)} lbs.`,
    { weight_lbs: snapshot.load.weightLbs, capacity_lbs: best },
  );
}

const APPROVED_CODES: ReadonlySet<string> = new Set(ACCESSORIAL_CODES);

/**
 * Allowlist membership and shape.
 *
 * The compiler guarantees `code` is an AccessorialCode for any caller inside
 * this codebase, but this data actually arrives as untyped JSON from the
 * model's tool call, where that guarantee does not reach -- hence the runtime
 * check.
 */
export function checkAccessorialsApproved(
  accessorials: readonly Accessorial[],
): PolicyRejection | null {
  for (const item of accessorials) {
    if (!APPROVED_CODES.has(item.code)) {
      return rejection(
        "accessorial_not_approved",
        `Accessorial '${String(item.code)}' is not on the approved list.`,
        { code: String(item.code) },
      );
    }
    if (item.amountCents < 0) {
      return rejection(
        "negative_amount",
        `Accessorial ${item.code} has a negative amount.`,
        { code: item.code, amount_cents: item.amountCents },
      );
    }
  }
  return null;
}

export function newlyApproved(
  snapshot: NegotiationSnapshot,
  accessorials: readonly Accessorial[],
): AccessorialCode[] {
  const seen = snapshot.approvedAccessorials;
  const out: AccessorialCode[] = [];
  for (const item of accessorials) {
    if (!seen.has(item.code) && !out.includes(item.code)) {
      out.push(item.code);
    }
  }
  return out;
}

/**
 * Bounds turns when linehaul never moves.
 *
 * Approving an accessorial ratchets the total but does not consume a counter,
 * so without this rule a carrier could request extras indefinitely. Money
 * would stay capped by the ceiling; turns, tokens and cost would not.
 */
export function checkAccessorialLimit(
  snapshot: NegotiationSnapshot,
  accessorials: readonly Accessorial[],
): PolicyRejection | null {
  const approved = snapshot.approvedAccessorials.size;
  const total = approved + newlyApproved(snapshot, accessorials).length;
  if (total <= MAX_ACCESSORIAL_APPROVALS) {
    return null;
  }
  return rejection(
    "accessorial_limit_reached",
    `This negotiation already carries ${approved} approved accessorials; ` +
      `the limit is ${MAX_ACCESSORIAL_APPROVALS}.`,
    { approved, limit: MAX_ACCESSORIAL_APPROVALS },
  );
}

/**
 * floor <= total <= maxCarrierPay, evaluated on TOTAL consideration.
 *
 * Checking linehaul alone is the failure this system exists to prevent: a
 * linehaul of $1,950 against a $2,040 ceiling looks fine, and $1,950 plus $150
 * detention plus $75 lumper is $2,175 with no single check having failed.
 */
export function checkWithinRateBand(
  snapshot: NegotiationSnapshot,
  totalCents: Cents,
): PolicyRejection | null {
  const { load } = snapshot;
  if (totalCents > load.maxCarrierPayCents) {
    return rejection(
      "above_max_carrier_pay",
      `Total consideration ${usd(totalCents)} exceeds maximum carrier pay ` +
        `${usd(load.maxCarrierPayCents)} for load ${load.loadId}. ` +
        "Accessorials count toward this ceiling.",
      { total_cents: totalCents, max_carrier_pay_cents: load.maxCarrierPayCents },
    );
  }
  if (totalCents < load.floorCents) {
    return rejection(
      "below_floor",
      `Total consideration ${usd(totalCents)} is below the negotiation floor ` +
        `${usd(load.floorCents)} for load ${load.loadId}.`,
      { total_cents: totalCents, floor_cents: load.floorCents },
    );
  }
  return null;
}

/**
 * A counter is a move in linehaul, not a change in total.
 *
 * The opening offer is not a counter. Adding an accessorial without moving
 * linehaul is not a counter either -- no round of negotiation elapsed.
 */
export function countsAsCounter(snapshot: NegotiationSnapshot, linehaulCents: Cents): boolean {
  const previous = snapshot.lastOfferLinehaulCents;
  return previous !== null && linehaulCents !== previous;
}

export function checkCounterLimit(
  snapshot: NegotiationSnapshot,
  linehaulCents: Cents,
): PolicyRejection | null {
  if (!countsAsCounter(snapshot, linehaulCents)) {
    return null;
  }
  if (snapshot.counterCount < MAX_COUNTERS) {
    return null;
  }
  return rejection(
    "counter_limit_reached",
    `This negotiation has already used ${snapshot.counterCount} of ${MAX_COUNTERS} ` +
      "counters. Accept the standing terms or escalate.",
    { counter_count: snapshot.counterCount, limit: MAX_COUNTERS },
  );
}

/**
 * Our offers climb; they never retract.
 *
 * Compared on total consideration, the same basis as the ceiling. If this rule
 * used linehaul while the ceiling used totals, $1,950 followed by $1,900 plus
 * $100 detention would pass the ratchet while actually being a rise to $2,000,
 * and the two rules would disagree about what an offer is.
 */
export function checkMonotonicNonDecreasing(
  snapshot: NegotiationSnapshot,
  totalCents: Cents,
): PolicyRejection | null {
  const previous = snapshot.lastOfferTotalCents;
  if (previous === null || totalCents >= previous) {
    return null;
  }
  return rejection(
    "offer_decreased",
    `Proposed total ${usd(totalCents)} is below our own previous offer of ` +
      `${usd(previous)}. Offers to a carrier never decrease.`,
    { total_cents: totalCents, previous_total_cents: previous },
  );
}

export function checkAmountIsSane(linehaulCents: Cents): PolicyRejection | null {
  if (linehaulCents > 0) {
    return null;
  }
  return rejection(
    "negative_amount",
    `Linehaul must be positive; got ${linehaulCents} cents.`,
    { linehaul_cents: linehaulCents },
  );
}
