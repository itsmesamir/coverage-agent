/**
 * Value types for the policy engine.
 *
 * Pure: only app/domain, nothing else. Money is integer cents throughout.
 *
 * Nothing here reads a clock. `now` is passed into `evaluateProposal` and
 * threaded down, so a decision is a function of its arguments alone. That is
 * what makes "authority lapsed four minutes in" a one-line deterministic test,
 * and what lets a stored trace be re-scored months later and reach the original
 * answer instead of being re-judged against today's date.
 */

import type { Equipment } from "../domain/equipment.js";
import type { NegotiationState } from "../domain/negotiation.js";

/**
 * Money. Invariant 8.
 *
 * The brand stops a plain dollar amount being passed where cents are expected.
 * It does not stop a fractional value -- `number` is a float64 -- so `cents()`
 * closes that gap with a runtime check.
 */
export type Cents = number & { readonly __brand: "cents" };

export function cents(value: number): Cents {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Money must be integer cents, got ${value}. Invariant 8.`);
  }
  return value as Cents;
}

/** Add cents to cents. Arithmetic on branded numbers widens, so re-brand. */
export function addCents(a: Cents, b: Cents): Cents {
  return (a + b) as Cents;
}

/**
 * The approved list. Anything outside it is rejected, by construction.
 *
 * An allowlist rather than a denylist for the same reason the import boundary
 * is: a denylist only blocks the charges someone thought to forbid, and
 * "accessorial creep" is precisely the carrier inventing a new one.
 */
export const ACCESSORIAL_CODES = [
  "detention",
  "layover",
  "lumper",
  "stop_off",
  "driver_assist",
  "tarp",
  "tonu",
] as const;

export type AccessorialCode = (typeof ACCESSORIAL_CODES)[number];

export const MAX_COUNTERS = 3;
export const MAX_ACCESSORIAL_APPROVALS = 3;

/** Machine-readable. The agent branches on these; humans read `explanation`. */
export const REJECTION_CODES = [
  "state_forbids_action",
  "authority_inactive",
  "equipment_type_not_permitted",
  "exceeds_trailer_capacity",
  "accessorial_not_approved",
  "accessorial_limit_reached",
  "above_max_carrier_pay",
  "below_floor",
  "counter_limit_reached",
  "offer_decreased",
  "negative_amount",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface Accessorial {
  readonly code: AccessorialCode;
  readonly amountCents: Cents;
}

export interface Load {
  readonly loadId: string;
  readonly equipment: Equipment;
  readonly weightLbs: number;
  readonly maxCarrierPayCents: Cents;
  readonly floorCents: Cents;
}

export interface Carrier {
  readonly carrierId: string;
  readonly equipment: readonly Equipment[];
  readonly authorityActive: boolean;
  /** Authority can lapse mid-negotiation. null means "no known expiry". */
  readonly authorityExpiresAt: Date | null;
}

/**
 * Everything the engine is allowed to know. Deliberately small.
 *
 * The LLM cannot put anything here: this is assembled from persisted state by
 * the tool layer, never from model output.
 */
export interface NegotiationSnapshot {
  readonly negotiationId: string;
  readonly state: NegotiationState;
  readonly load: Load;
  readonly carrier: Carrier;
  readonly counterCount: number;
  /** Highest total we have offered this carrier. The ratchet compares to this. */
  readonly lastOfferTotalCents: Cents | null;
  /**
   * Linehaul of that offer. A counter is a move in *linehaul*, not in total,
   * which is how approving an accessorial ratchets without burning a counter.
   */
  readonly lastOfferLinehaulCents: Cents | null;
  readonly approvedAccessorials: ReadonlySet<AccessorialCode>;
}

// --- proposals: what the model may ask for ---------------------------------

/**
 * The `kind` discriminant is load-bearing, not decoration.
 *
 * ProposeRate and AcceptCounter have identical fields. Under structural typing
 * that makes them the same type without a discriminant, and the state rule
 * could not tell "propose a rate" from "accept the carrier's number" apart.
 */
export interface ProposeRate {
  readonly kind: "propose_rate";
  readonly linehaulCents: Cents;
  readonly accessorials: readonly Accessorial[];
}

/**
 * Accepting the carrier's terms. Same rules apply -- a carrier's number is not
 * safer than our own just because they said it first.
 */
export interface AcceptCounter {
  readonly kind: "accept_counter";
  readonly linehaulCents: Cents;
  readonly accessorials: readonly Accessorial[];
}

export interface BookCarrier {
  readonly kind: "book_carrier";
  readonly linehaulCents: Cents;
  readonly idempotencyKey: string;
  readonly accessorials: readonly Accessorial[];
}

export type Proposal = ProposeRate | AcceptCounter | BookCarrier;

/** Human-readable name for a proposal kind, for rejection messages. */
export const PROPOSAL_LABELS = {
  propose_rate: "ProposeRate",
  accept_counter: "AcceptCounter",
  book_carrier: "BookCarrier",
} as const satisfies Record<Proposal["kind"], string>;

export function proposeRate(
  linehaulCents: Cents,
  accessorials: readonly Accessorial[] = [],
): ProposeRate {
  return { kind: "propose_rate", linehaulCents, accessorials };
}

export function acceptCounter(
  linehaulCents: Cents,
  accessorials: readonly Accessorial[] = [],
): AcceptCounter {
  return { kind: "accept_counter", linehaulCents, accessorials };
}

export function bookCarrier(
  linehaulCents: Cents,
  idempotencyKey: string,
  accessorials: readonly Accessorial[] = [],
): BookCarrier {
  return { kind: "book_carrier", linehaulCents, idempotencyKey, accessorials };
}

// --- outcomes ---------------------------------------------------------------

/**
 * An approved proposal. The renderer may use these numbers and no others.
 *
 * `totalCents` is what we will owe the carrier, linehaul plus accessorials. It
 * is the number every money rule is evaluated against.
 */
export interface RateDecision {
  /** Discriminant, not a convenience flag: `if (result.approved)` narrows. */
  readonly approved: true;
  readonly negotiationId: string;
  readonly linehaulCents: Cents;
  readonly accessorials: readonly Accessorial[];
  readonly totalCents: Cents;
  readonly countsAsCounter: boolean;
  readonly newlyApprovedAccessorials: readonly AccessorialCode[];
}

/**
 * A refusal the agent can act on.
 *
 * `code` is for branching, `explanation` goes back into the model's context so
 * it can re-plan. The explanation states what was wrong and what the binding
 * limit is -- never what to offer instead, which would make the engine the
 * negotiator.
 */
export interface PolicyRejection {
  readonly approved: false;
  readonly code: RejectionCode;
  readonly explanation: string;
  readonly details: Readonly<Record<string, number | string>>;
}

export type PolicyResult = RateDecision | PolicyRejection;

export function rejection(
  code: RejectionCode,
  explanation: string,
  details: Readonly<Record<string, number | string>> = {},
): PolicyRejection {
  return { approved: false, code, explanation, details };
}

/**
 * The single definition of "what this costs us".
 *
 * Every money rule uses this. If the ceiling checked totals and the ratchet
 * checked linehaul, an agent could raise the total while appearing to hold
 * steady, and the two rules would disagree about what an offer even is.
 */
export function totalConsideration(
  linehaulCents: Cents,
  accessorials: readonly Accessorial[],
): Cents {
  let total: number = linehaulCents;
  for (const item of accessorials) {
    total += item.amountCents;
  }
  return total as Cents;
}

/**
 * Compile-time exhaustiveness. Reaching this at runtime means a union gained a
 * member and a switch did not, which `tsc` should already have refused.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
