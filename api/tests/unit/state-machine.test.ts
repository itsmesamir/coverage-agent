/** Every legal transition, and a representative set of illegal ones. */

import { describe, expect, expectTypeOf, it } from "vitest";
import { NEGOTIATION_STATES, TERMINAL_STATES, type NegotiationState } from "../../app/domain/negotiation.js";
import * as machine from "../../app/state/machine.js";
import {
  apply,
  EVENTS,
  IllegalTransition,
  newNegotiationStatus,
  TRANSITIONS,
  isTerminal,
  type Event,
} from "../../app/state/machine.js";

const LEGAL: Array<[NegotiationState, Event, NegotiationState]> = [];
for (const state of NEGOTIATION_STATES) {
  const row = TRANSITIONS[state] as Partial<Record<Event, NegotiationState>>;
  for (const [event, dest] of Object.entries(row) as Array<[Event, NegotiationState]>) {
    LEGAL.push([state, event, dest]);
  }
}

const ILLEGAL: Array<[NegotiationState, Event]> = [];
for (const state of NEGOTIATION_STATES) {
  for (const event of EVENTS) {
    if (!(event in TRANSITIONS[state])) {
      ILLEGAL.push([state, event]);
    }
  }
}

// --- the table itself ------------------------------------------------------

describe("the transition table", () => {
  it("has an entry for every state", () => {
    // TypeScript already guarantees this at compile time (TRANSITIONS
    // `satisfies Record<NegotiationState, ...>`); this is a runtime
    // regression net for anyone who weakens that type later.
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...NEGOTIATION_STATES].sort());
  });

  it("terminal states have no outgoing edges", () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state]).toEqual({});
    }
  });

  it("every non-terminal state can escalate", () => {
    // A human must always be reachable from anywhere still in play.
    for (const state of NEGOTIATION_STATES) {
      if (TERMINAL_STATES.has(state)) continue;
      expect("escalated" in TRANSITIONS[state]).toBe(true);
    }
  });

  it("every state is reachable from NEW", () => {
    const reached = new Set<NegotiationState>(["NEW"]);
    const frontier: NegotiationState[] = ["NEW"];
    while (frontier.length > 0) {
      const state = frontier.pop()!;
      for (const dest of Object.values(TRANSITIONS[state]) as NegotiationState[]) {
        if (!reached.has(dest)) {
          reached.add(dest);
          frontier.push(dest);
        }
      }
    }
    expect(reached).toEqual(new Set(NEGOTIATION_STATES));
  });
});

// --- every legal transition -------------------------------------------------

describe("every legal transition", () => {
  it.each(LEGAL)("%s + %s -> %s", (state, event, destination) => {
    const result = apply(newNegotiationStatus(state, 4), event);
    expect(result.state).toBe(destination);
    expect(result.version).toBe(5);
  });
});

// --- every illegal transition ------------------------------------------------

describe("every illegal transition throws", () => {
  it.each(ILLEGAL)("%s + %s throws IllegalTransition", (state, event) => {
    // Illegal transitions must throw rather than silently pass.
    expect(() => apply(newNegotiationStatus(state), event)).toThrow(IllegalTransition);
  });
});

it("names what would have been legal", () => {
  expect(() => apply(newNegotiationStatus("NEW"), "booking_confirmed")).toThrowError(
    expect.objectContaining({
      message: expect.stringContaining("NEW") && expect.stringContaining("opening_offer_sent"),
    }),
  );
  try {
    apply(newNegotiationStatus("NEW"), "booking_confirmed");
  } catch (err) {
    expect(String(err)).toContain("NEW");
    expect(String(err)).toContain("opening_offer_sent");
  }
});

it("a booked load cannot be moved by any event", () => {
  for (const event of EVENTS) {
    expect(() => apply(newNegotiationStatus("BOOKED"), event)).toThrow(IllegalTransition);
  }
});

it("cannot skip from NEW to BOOKED", () => {
  expect(() => apply(newNegotiationStatus("NEW"), "booking_confirmed")).toThrow(IllegalTransition);
});

it("cannot book without agreeing first", () => {
  expect(() => apply(newNegotiationStatus("NEGOTIATING"), "booking_started")).toThrow(
    IllegalTransition,
  );
});

// --- purity and versioning ---------------------------------------------------

describe("purity and versioning", () => {
  it("apply does not mutate its input", () => {
    const before = newNegotiationStatus("NEW", 1);
    const snapshot = { ...before };
    apply(before, "opening_offer_sent");
    expect(before).toEqual(snapshot);
  });

  it("version increments on every transition", () => {
    let status = newNegotiationStatus();
    for (const event of ["opening_offer_sent", "carrier_replied", "terms_agreed"] as const) {
      status = apply(status, event);
    }
    expect(status.version).toBe(4);
  });

  it("a failed transition leaves the version untouched", () => {
    // Nothing to roll back: a rejected write must not consume a version.
    const status = newNegotiationStatus("NEW", 7);
    expect(() => apply(status, "booking_confirmed")).toThrow(IllegalTransition);
    expect(status.version).toBe(7);
  });

  it("isTerminal", () => {
    expect(isTerminal(newNegotiationStatus("BOOKED"))).toBe(true);
    expect(isTerminal(newNegotiationStatus("FAILED"))).toBe(true);
    expect(isTerminal(newNegotiationStatus("NEGOTIATING"))).toBe(false);
  });
});

// --- the round trip -----------------------------------------------------------

it("the full happy path", () => {
  let status = newNegotiationStatus();
  const events = [
    "opening_offer_sent",
    "carrier_replied",
    "counter_sent",
    "carrier_replied",
    "terms_agreed",
    "booking_started",
    "booking_confirmed",
  ] as const;
  for (const event of events) {
    status = apply(status, event);
  }
  expect(status.state).toBe("BOOKED");
  expect(status.version).toBe(8);
});

it("a negotiation can loop between NEGOTIATING and WAITING_FOR_RESPONSE", () => {
  // Counter, reply, counter, reply. The loop that burns counters -- bounded
  // by the policy engine, not by the state machine. Two different jobs.
  let status = newNegotiationStatus("NEGOTIATING");
  for (let i = 0; i < 5; i++) {
    status = apply(status, "counter_sent");
    expect(status.state).toBe("WAITING_FOR_RESPONSE");
    status = apply(status, "carrier_replied");
    expect(status.state).toBe("NEGOTIATING");
  }
});

// --- invariant 4, structurally -------------------------------------------------

it("there is no way to name a target state", () => {
  // Invariant 4, checked two ways:
  // (1) apply's second parameter type is Event, not NegotiationState -- a
  //     compile-time fact, asserted here so it cannot silently drift.
  expectTypeOf(apply).parameter(1).toEqualTypeOf<Event>();
  // (2) no exported function offers a way to set a destination directly.
  const exported = Object.keys(machine);
  expect(exported.some((name) => /^set/i.test(name))).toBe(false);
});
