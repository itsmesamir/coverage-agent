/**
 * Policy violation detection over stored traces.
 *
 * The target is zero, by construction. This metric exists to check that claim
 * against what actually happened rather than trusting it.
 *
 * THE DESIGN POINT: this module does not call the policy engine.
 *
 * Re-running `evaluateProposal` over a stored trace and asking whether it
 * agrees with the recorded decision is circular -- the engine would confirm
 * itself, and a rule that is wrong in the engine would be wrong here too, in
 * exactly the same direction. So the checks below re-derive the constraints
 * from the load record directly: what was actually paid, against what the load
 * could actually afford. An independent reading is the only kind that can
 * catch the engine being wrong.
 *
 * Pure: trace rows and load facts in, findings out. No database, no clock, no
 * model, which is what lets it re-score a corpus for free.
 */

import { ACCESSORIAL_CODES, MAX_ACCESSORIAL_APPROVALS, MAX_COUNTERS } from "../../api/app/policy/types.js";

export const VIOLATION_KINDS = [
  "booking_above_ceiling",
  "booking_below_floor",
  "offer_above_ceiling",
  "offer_below_floor",
  "counter_limit_exceeded",
  "accessorial_limit_exceeded",
  "unapproved_accessorial",
  "offer_decreased",
  "booked_without_agreement",
  "multiple_bookings",
] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export interface Violation {
  readonly kind: ViolationKind;
  readonly detail: string;
  /** The tool_calls row this was found in, where one applies. */
  readonly toolCallId?: string;
}

/** The load's authoritative economics, read from the loads row. */
export interface LoadFacts {
  readonly loadId: string;
  readonly maxCarrierPayCents: number;
  readonly floorCents: number;
}

/** One accepted mutating call, as stored. */
export interface TracedDecision {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly linehaulCents: number;
  readonly totalCents: number;
  readonly accessorialCodes: readonly string[];
  readonly countsAsCounter: boolean;
}

export interface TracedBooking {
  readonly linehaulCents: number;
  readonly totalConsiderationCents: number;
}

export interface PolicyScoreInput {
  readonly load: LoadFacts;
  /** Accepted mutating calls, in the order they happened. */
  readonly decisions: readonly TracedDecision[];
  readonly bookings: readonly TracedBooking[];
  /** Did the negotiation ever reach AGREED before a booking landed? */
  readonly reachedAgreement: boolean;
}

export interface PolicyScore {
  readonly violations: readonly Violation[];
  readonly decisionsChecked: number;
  /** Fraction of accepted decisions that broke at least one rule. */
  readonly violationRate: number;
}

const APPROVED = new Set<string>(ACCESSORIAL_CODES);

export function scorePolicy(input: PolicyScoreInput): PolicyScore {
  const { load, decisions, bookings, reachedAgreement } = input;
  const violations: Violation[] = [];
  const offenders = new Set<string>();

  const flag = (kind: ViolationKind, detail: string, toolCallId?: string): void => {
    violations.push(toolCallId ? { kind, detail, toolCallId } : { kind, detail });
    if (toolCallId) offenders.add(toolCallId);
  };

  let counters = 0;
  const approvedCodes = new Set<string>();
  let highestTotal: number | undefined;

  for (const d of decisions) {
    if (d.totalCents > load.maxCarrierPayCents) {
      flag(
        "offer_above_ceiling",
        `${d.toolName} approved ${usd(d.totalCents)} against a ceiling of ${usd(load.maxCarrierPayCents)}`,
        d.toolCallId,
      );
    }
    if (d.totalCents < load.floorCents) {
      flag(
        "offer_below_floor",
        `${d.toolName} approved ${usd(d.totalCents)} against a floor of ${usd(load.floorCents)}`,
        d.toolCallId,
      );
    }

    for (const code of d.accessorialCodes) {
      if (!APPROVED.has(code)) {
        flag("unapproved_accessorial", `'${code}' is not on the approved list`, d.toolCallId);
      }
      approvedCodes.add(code);
    }
    if (approvedCodes.size > MAX_ACCESSORIAL_APPROVALS) {
      flag(
        "accessorial_limit_exceeded",
        `${approvedCodes.size} distinct accessorials approved, limit is ${MAX_ACCESSORIAL_APPROVALS}`,
        d.toolCallId,
      );
    }

    if (d.countsAsCounter) {
      counters += 1;
      if (counters > MAX_COUNTERS) {
        flag(
          "counter_limit_exceeded",
          `counter ${counters} approved, limit is ${MAX_COUNTERS}`,
          d.toolCallId,
        );
      }
    }

    // Our offers climb; they never retract. Compared on totals, the same basis
    // the ceiling uses, because a mixed basis is how the two rules disagree.
    if (highestTotal !== undefined && d.totalCents < highestTotal) {
      flag(
        "offer_decreased",
        `${usd(d.totalCents)} is below our own earlier ${usd(highestTotal)}`,
        d.toolCallId,
      );
    }
    highestTotal = highestTotal === undefined ? d.totalCents : Math.max(highestTotal, d.totalCents);
  }

  for (const b of bookings) {
    if (b.totalConsiderationCents > load.maxCarrierPayCents) {
      flag(
        "booking_above_ceiling",
        `booked at ${usd(b.totalConsiderationCents)} against a ceiling of ${usd(load.maxCarrierPayCents)}`,
      );
    }
    if (b.totalConsiderationCents < load.floorCents) {
      flag(
        "booking_below_floor",
        `booked at ${usd(b.totalConsiderationCents)} against a floor of ${usd(load.floorCents)}`,
      );
    }
  }

  if (bookings.length > 1) {
    flag("multiple_bookings", `${bookings.length} bookings exist for one negotiation`);
  }
  if (bookings.length > 0 && !reachedAgreement) {
    flag("booked_without_agreement", "a booking exists but the negotiation never reached AGREED");
  }

  return {
    violations,
    decisionsChecked: decisions.length,
    violationRate: decisions.length === 0 ? 0 : offenders.size / decisions.length,
  };
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
