/**
 * Outbound message templates.
 *
 * Invariant 2: no price reaches a counterparty as LLM-generated text. The model
 * calls `propose_rate`; the engine returns a `RateDecision`; this module renders
 * the message from `decision.linehaulCents` and `decision.totalCents`.
 *
 * The enforcement is structural rather than procedural. `RenderFacts` is the
 * ONLY input, it contains no free-text field, and nothing in this module
 * accepts a string from the model. There is no argument through which a
 * model-authored sentence -- or a model-authored number -- could reach a
 * carrier, so invariant 2 cannot be violated without changing this signature.
 *
 * Why there is no `send_free_text` tool, which is the same question from the
 * other side: such a tool would take a model-authored string and put it in
 * front of a carrier. Every guarantee in this system would become advisory.
 * The policy engine could approve $1,950 and the model could still type
 * "we can do $2,400" in the body; the hallucination metric would have to grade
 * prose rather than check claims against a record; and "the price came from
 * validated state" would be a hope rather than a property. The small, awkward
 * set of templates here is the cost of that guarantee, and it is worth it.
 *
 * Pure: formatting only. No clock, no I/O, no arithmetic that invents a number
 * -- cents are divided by 100 for display and nothing else.
 */

import type { Equipment } from "../domain/equipment.js";
import type { Accessorial, Cents, RateDecision } from "../policy/types.js";

export interface RenderLoad {
  readonly loadId: string;
  readonly origin: string;
  readonly destination: string;
  readonly equipment: Equipment;
  readonly weightLbs: number;
  readonly commodity: string;
  readonly pickupAt: Date;
}

export interface RenderFacts {
  readonly carrierName: string;
  readonly brokerName: string;
  readonly load: RenderLoad;
  /** The only source of money in an outbound message. */
  readonly decision: RateDecision;
}

export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
}

const EQUIPMENT_LABEL: Record<Equipment, string> = {
  dry_van: "dry van",
  reefer: "reefer",
  flatbed: "flatbed",
  specialized: "specialized",
};

const ACCESSORIAL_LABEL: Record<string, string> = {
  detention: "detention",
  layover: "layover",
  lumper: "lumper fee",
  stop_off: "stop-off",
  driver_assist: "driver assist",
  tarp: "tarping",
  tonu: "truck ordered not used",
};

/** Cents to dollars. Display formatting, not derivation. */
export function formatMoney(cents: Cents | number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${fraction}`;
}

export function formatWeight(lbs: number): string {
  return `${lbs.toLocaleString("en-US")} lbs`;
}

/**
 * Fixed UTC formatting. Not locale-dependent and not the machine's timezone,
 * so the same load renders identically on a laptop and in CI -- which matters
 * because eval replay compares stored message bodies.
 */
export function formatPickup(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

function loadSummary(load: RenderLoad): string {
  return [
    `Load ${load.loadId}`,
    `${load.origin} to ${load.destination}`,
    EQUIPMENT_LABEL[load.equipment],
    formatWeight(load.weightLbs),
    load.commodity,
    `pickup ${formatPickup(load.pickupAt)}`,
  ].join(" | ");
}

function accessorialLines(accessorials: readonly Accessorial[]): string[] {
  return accessorials.map(
    (a) => `  ${ACCESSORIAL_LABEL[a.code] ?? a.code}: ${formatMoney(a.amountCents)}`,
  );
}

function rateBlock(decision: RateDecision): string {
  const lines = [`  linehaul: ${formatMoney(decision.linehaulCents)}`];
  lines.push(...accessorialLines(decision.accessorials));
  if (decision.accessorials.length > 0) {
    lines.push(`  total: ${formatMoney(decision.totalCents)}`);
  }
  return lines.join("\n");
}

export function renderOpeningOffer(facts: RenderFacts): RenderedMessage {
  const { load, decision, carrierName, brokerName } = facts;
  return {
    subject: `Load ${load.loadId}: ${load.origin} to ${load.destination}`,
    body: [
      `Hi ${carrierName},`,
      "",
      `We have a load available and thought it might fit your lanes.`,
      "",
      loadSummary(load),
      "",
      `Our offer:`,
      rateBlock(decision),
      "",
      `If that works, reply to confirm and we will send the rate confirmation.`,
      "",
      brokerName,
    ].join("\n"),
  };
}

export function renderCounterOffer(facts: RenderFacts): RenderedMessage {
  const { load, decision, carrierName, brokerName } = facts;
  return {
    subject: `Re: Load ${load.loadId}: ${load.origin} to ${load.destination}`,
    body: [
      `Hi ${carrierName},`,
      "",
      `Thanks for coming back to us. Here is where we can get to on this one:`,
      "",
      rateBlock(decision),
      "",
      loadSummary(load),
      "",
      `Let us know either way and we will move quickly.`,
      "",
      brokerName,
    ].join("\n"),
  };
}

export function renderAcceptance(facts: RenderFacts): RenderedMessage {
  const { load, decision, carrierName, brokerName } = facts;
  return {
    subject: `Agreed: Load ${load.loadId} at ${formatMoney(decision.totalCents)}`,
    body: [
      `Hi ${carrierName},`,
      "",
      `Agreed at the following terms:`,
      "",
      rateBlock(decision),
      "",
      loadSummary(load),
      "",
      `We are preparing the rate confirmation now.`,
      "",
      brokerName,
    ].join("\n"),
  };
}

export function renderBookingConfirmation(
  facts: RenderFacts,
  bookingReference: string,
): RenderedMessage {
  const { load, decision, carrierName, brokerName } = facts;
  return {
    subject: `Booked: Load ${load.loadId} (${bookingReference})`,
    body: [
      `Hi ${carrierName},`,
      "",
      `You are booked. Reference ${bookingReference}.`,
      "",
      loadSummary(load),
      "",
      `Agreed rate:`,
      rateBlock(decision),
      "",
      `Please confirm driver and truck details before pickup.`,
      "",
      brokerName,
    ].join("\n"),
  };
}

