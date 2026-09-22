/**
 * The negotiation state machine. Pure: only app/domain, nothing else.
 *
 * There is no `setState()`. The only way to move a negotiation is
 * `apply(status, event)`, where events are facts about what already happened
 * -- a message was sent, the carrier replied, a booking was confirmed.
 * Nothing in this API accepts a target state, which is how invariant 4 (the
 * model never mutates negotiation state directly) is enforced rather than
 * merely requested.
 *
 * Illegal transitions throw; the policy engine returns a rejection instead.
 * Deliberately different: a policy rejection is an expected outcome the agent
 * re-plans on, but deriving BOOKED from NEW is a programming error with no
 * legitimate code path, and should not be silently ignorable.
 *
 * Every transition increments a version. This module never touches a
 * database, but it defines the contract a caller must honor when persisting:
 * `WHERE id = ? AND version = <expected>`. Zero rows affected means another
 * writer moved first.
 *
 * `TRANSITIONS` is declared `satisfies Record<NegotiationState, ...>`, so
 * omitting a state is a compile error rather than something only a test
 * would catch.
 */

import { TERMINAL_STATES, type NegotiationState } from "../domain/negotiation.js";

export const EVENTS = [
  "opening_offer_sent",
  "carrier_replied",
  "counter_sent",
  "terms_agreed",
  "booking_started",
  "booking_confirmed",
  "booking_failed",
  "carrier_declined",
  "no_response",
  "escalated",
] as const;

/** Things that happened. Never "what state to go to". */
export type Event = (typeof EVENTS)[number];

type TransitionRow = Partial<Record<Event, NegotiationState>>;

/**
 * The legal transition table, written out in full. Anything absent is
 * illegal. `satisfies` forces every NegotiationState to have a row.
 */
export const TRANSITIONS = {
  NEW: {
    opening_offer_sent: "CARRIER_CONTACTED",
    escalated: "ESCALATED",
  },
  CARRIER_CONTACTED: {
    carrier_replied: "NEGOTIATING",
    no_response: "WAITING_FOR_RESPONSE",
    carrier_declined: "FAILED",
    escalated: "ESCALATED",
  },
  WAITING_FOR_RESPONSE: {
    carrier_replied: "NEGOTIATING",
    no_response: "FAILED",
    carrier_declined: "FAILED",
    escalated: "ESCALATED",
  },
  NEGOTIATING: {
    counter_sent: "WAITING_FOR_RESPONSE",
    terms_agreed: "AGREED",
    carrier_declined: "FAILED",
    no_response: "FAILED",
    escalated: "ESCALATED",
  },
  AGREED: {
    booking_started: "BOOKING",
    // Authority can lapse between agreement and booking. That is not a
    // failure of the agreement, it is a reason to involve a human.
    escalated: "ESCALATED",
  },
  BOOKING: {
    booking_confirmed: "BOOKED",
    booking_failed: "ESCALATED",
    escalated: "ESCALATED",
  },
  // Terminal. No event leaves them, including "escalated": a booked load
  // cannot be un-booked by the agent, and an escalated one belongs to a human.
  BOOKED: {},
  ESCALATED: {},
  FAILED: {},
} as const satisfies Record<NegotiationState, TransitionRow>;

/** Raised when no legal edge exists. A bug, not a business outcome. */
export class IllegalTransition extends Error {
  readonly state: NegotiationState;
  readonly event: Event;

  constructor(state: NegotiationState, event: Event) {
    const legalEvents = Object.keys(TRANSITIONS[state]).sort();
    const legal = legalEvents.length > 0 ? legalEvents.join(", ") : "none";
    super(
      `Cannot apply '${event}' to a negotiation in ${state}. Legal events from here: ${legal}.`,
    );
    this.name = "IllegalTransition";
    this.state = state;
    this.event = event;
  }
}

/** State plus the version the next write must be conditioned on. */
export interface NegotiationStatus {
  readonly state: NegotiationState;
  readonly version: number;
}

export function newNegotiationStatus(
  state: NegotiationState = "NEW",
  version = 1,
): NegotiationStatus {
  return { state, version };
}

export function isTerminal(status: NegotiationStatus): boolean {
  return TERMINAL_STATES.has(status.state);
}

export function legalEvents(state: NegotiationState): ReadonlySet<Event> {
  return new Set(Object.keys(TRANSITIONS[state]) as Event[]);
}

export function canApply(state: NegotiationState, event: Event): boolean {
  return event in TRANSITIONS[state];
}

/**
 * Return the next status. Pure: the input is never mutated.
 * Throws IllegalTransition if no legal edge exists.
 */
export function apply(status: NegotiationStatus, event: Event): NegotiationStatus {
  const row: TransitionRow = TRANSITIONS[status.state];
  const destination = row[event];
  if (destination === undefined) {
    throw new IllegalTransition(status.state, event);
  }
  return { state: destination, version: status.version + 1 };
}
