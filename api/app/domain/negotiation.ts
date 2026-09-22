/**
 * Negotiation lifecycle vocabulary.
 *
 * `NegotiationState` lives in domain/ rather than policy/ or state/ because
 * both of those need it, and the import boundary forbids them importing each
 * other. Shared vocabulary belongs one layer further in.
 *
 * Pure: no imports at all. Enforced by .dependency-cruiser.cjs (domain-no-external).
 */

export const NEGOTIATION_STATES = [
  "NEW",
  "CARRIER_CONTACTED",
  "WAITING_FOR_RESPONSE",
  "NEGOTIATING",
  "AGREED",
  "BOOKING",
  "BOOKED",
  "ESCALATED",
  "FAILED",
] as const;

export type NegotiationState = (typeof NEGOTIATION_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<NegotiationState> = new Set([
  "BOOKED",
  "ESCALATED",
  "FAILED",
]);
