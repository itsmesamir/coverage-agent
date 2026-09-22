/**
 * Carrier personas: what a simulated counterparty wants and how it behaves.
 *
 * The split here mirrors the system under test. A persona's NUMBERS -- opening
 * ask, walk-away price, how fast it concedes, how long its patience lasts --
 * live in a plain config object and are turned into a decision by a pure
 * function. The LLM is only ever asked to phrase a decision already made into
 * something that reads like a real reply.
 *
 * Two reasons, both load-bearing:
 *
 * 1. Reproducibility. An eval that lets a model pick the counter-offer is an
 *    eval whose numbers move when the model changes, the temperature changes,
 *    or the provider reroutes to a different checkpoint. Deciding in code means
 *    the same case walks the same trajectory every run, so when a metric moves
 *    it is because the AGENT changed.
 *
 * 2. Tunability without prompt editing. Making a carrier tougher is a number,
 *    not a paragraph. If "tougher" required rewriting prose it would not be
 *    measurable.
 */

export const PERSONA_BEHAVIOURS = [
  "straightforward",
  "accessorial_creep",
  "off_topic",
  "ambiguous",
  "prompt_injection",
] as const;
export type PersonaBehaviour = (typeof PERSONA_BEHAVIOURS)[number];

/**
 * The carrier's own economics, in integer cents.
 *
 * A carrier is a seller: it opens high and conceeds downward toward the least
 * it will accept. `walkAwayCents` is its reservation price and is never
 * revealed, so the agent has to discover whether a deal exists at all.
 */
export interface CarrierStrategy {
  /** First counter, before any concession. */
  readonly openingAskCents: number;
  /** The least this carrier will take. Below it, the answer is no. */
  readonly walkAwayCents: number;
  /** How much the ask drops per turn. */
  readonly concessionPerTurnCents: number;
  /** Turns of negotiation before the carrier disengages. */
  readonly patienceTurns: number;
  /** Take the first offer at or above walk-away without countering. */
  readonly acceptsImmediately?: boolean;
  /** Accessorial demands in cents, introduced one per turn while countering. */
  readonly accessorialDemandsCents?: readonly number[];
}

export interface Persona {
  readonly id: string;
  readonly label: string;
  readonly behaviour: PersonaBehaviour;
  readonly strategy: CarrierStrategy;
  /** Tone and framing for phrasing only. Never asked to choose a number. */
  readonly systemPrompt: string;
  /**
   * Turn at which this carrier's operating authority goes inactive, if ever.
   * The persona behaves normally; the harness flips the flag, which is what
   * makes the agent's re-validation at booking time observable.
   */
  readonly authorityLapsesAtTurn?: number;
}

export const MOVE_KINDS = [
  "accept",
  "counter",
  "decline",
  "silent",
  "off_topic",
  "ambiguous",
  "inject",
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** What the carrier decided, before any words are put to it. */
export interface CarrierMove {
  readonly kind: MoveKind;
  /** What the carrier is asking for, when the move involves a number. */
  readonly askCents?: number;
  /** An accessorial demanded on top, in cents. */
  readonly accessorialCents?: number;
  /** Why. Recorded for the trace, never sent to the agent. */
  readonly rationale: string;
}
