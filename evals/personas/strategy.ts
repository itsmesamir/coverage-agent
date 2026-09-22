/**
 * What the carrier does next. Pure: config plus the offer on the table plus
 * the turn number, in; a decision, out. No model, no clock, no I/O.
 *
 * This is the half of a persona that an eval depends on. The phrasing layer
 * can be as nondeterministic as it likes, because nothing downstream reads
 * the prose for a number -- the agent's own policy engine re-derives every
 * figure from validated state.
 */

import type { CarrierMove, CarrierStrategy, PersonaBehaviour } from "./types.js";

/**
 * The carrier's asking price on a given turn.
 *
 * Linear concession from the opening ask, floored at the walk-away price. Turn
 * numbering starts at 1, so the opening ask stands on the first turn.
 */
export function askOnTurn(strategy: CarrierStrategy, turn: number): number {
  const conceded = strategy.openingAskCents - strategy.concessionPerTurnCents * (turn - 1);
  return Math.max(strategy.walkAwayCents, conceded);
}

/**
 * Parse what we offered out of a rendered outbound message.
 *
 * The carrier reads the email like a person would rather than being handed the
 * decision object, which keeps the simulation honest about what a counterparty
 * actually has access to. `total:` wins over `linehaul:` when both are present,
 * because the total is what the carrier would actually be paid.
 */
export function parseOfferCents(body: string): number | undefined {
  const find = (label: string): number | undefined => {
    const match = new RegExp(`${label}:\\s*\\$([\\d,]+)\\.(\\d{2})`).exec(body);
    if (!match) return undefined;
    return Number(match[1]!.replace(/,/g, "")) * 100 + Number(match[2]);
  };
  return find("total") ?? find("linehaul");
}

export interface MoveContext {
  readonly strategy: CarrierStrategy;
  readonly behaviour: PersonaBehaviour;
  /** What the agent just offered, in cents. Undefined if we could not parse one. */
  readonly offerCents: number | undefined;
  /** 1-based turn number. */
  readonly turn: number;
}

export function decideMove(context: MoveContext): CarrierMove {
  const { strategy, behaviour, offerCents, turn } = context;

  if (turn > strategy.patienceTurns) {
    // Out of patience. Going quiet is more realistic than a formal decline and
    // it exercises the agent's no-response path, which a decline would not.
    return { kind: "silent", rationale: `patience of ${strategy.patienceTurns} turns exhausted` };
  }

  // A behaviour that never engages with price does its thing regardless of the
  // number on the table. These exist to check the agent does not read consent
  // or agreement into text that contains neither.
  if (behaviour === "off_topic") {
    return { kind: "off_topic", rationale: "never engages with the rate" };
  }
  if (behaviour === "ambiguous") {
    return { kind: "ambiguous", rationale: "replies without accepting or rejecting" };
  }
  if (behaviour === "prompt_injection") {
    // Attempted every turn until patience runs out: if it ever works, the
    // policy engine failed, and a single attempt would be a thin test.
    //
    // The number matters. An injection has to demand something the agent
    // genuinely cannot approve, or "the agent refused" proves nothing about
    // whether it would have refused a figure outside the band.
    return {
      kind: "inject",
      askCents: strategy.openingAskCents,
      rationale: "attempts to override the agent's instructions",
    };
  }

  if (offerCents === undefined) {
    return { kind: "ambiguous", rationale: "no price found in the message to respond to" };
  }

  if (strategy.acceptsImmediately && offerCents >= strategy.walkAwayCents) {
    return { kind: "accept", askCents: offerCents, rationale: "takes any workable first offer" };
  }

  const ask = askOnTurn(strategy, turn);
  if (offerCents >= ask) {
    return { kind: "accept", askCents: offerCents, rationale: `offer met the turn-${turn} ask` };
  }

  // Accessorial creep: hold the linehaul position but add a new charge each
  // turn, which is the behaviour the approval cap exists to bound.
  if (behaviour === "accessorial_creep") {
    const demands = strategy.accessorialDemandsCents ?? [];
    const demand = demands[Math.min(turn - 1, demands.length - 1)];
    if (demand !== undefined) {
      return {
        kind: "counter",
        askCents: ask,
        accessorialCents: demand,
        rationale: `counters at the turn-${turn} ask and adds an accessorial`,
      };
    }
  }

  // At the floor and still not met: there is no deal to be had.
  if (ask <= strategy.walkAwayCents && offerCents < strategy.walkAwayCents) {
    return {
      kind: "decline",
      askCents: strategy.walkAwayCents,
      rationale: "offer is below the walk-away price with no room left to concede",
    };
  }

  return { kind: "counter", askCents: ask, rationale: `counters at the turn-${turn} ask` };
}
