/**
 * The central test: a rendered body contains no number that did not originate
 * in validated state.
 *
 * The method is deliberately adversarial. Rather than checking that the right
 * numbers are present, it extracts EVERY digit run from the output and requires
 * each one to be traceable to a declared fact. A hardcoded figure, a computed
 * discount, a stray year, an invented phone number -- anything a template
 * author or a future refactor might slip in -- fails.
 */

import { describe, expect, it } from "vitest";

import { cents, type Accessorial, type RateDecision } from "../../app/policy/types.js";
import {
  formatMoney,
  formatPickup,
  formatWeight,
  renderAcceptance,
  renderBookingConfirmation,
  renderCounterOffer,
  renderOpeningOffer,
  type RenderFacts,
} from "../../app/agent/render.js";

const detention: Accessorial = { code: "detention", amountCents: cents(15_000) };

function decision(over: Partial<RateDecision> = {}): RateDecision {
  return {
    approved: true,
    negotiationId: "N-1",
    linehaulCents: cents(195_000),
    accessorials: [],
    totalCents: cents(195_000),
    countsAsCounter: false,
    newlyApprovedAccessorials: [],
    ...over,
  };
}

const FACTS: RenderFacts = {
  carrierName: "Cedar Line Transport 64",
  brokerName: "Coverage Desk",
  load: {
    loadId: "L-4471",
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    weightLbs: 42_000,
    commodity: "general freight",
    pickupAt: new Date("2026-09-15T08:00:00Z"),
  },
  decision: decision(),
};

/**
 * Every number in the text, keeping thousands separators and decimals but not
 * trailing punctuation -- "Transport 64," is the number 64, and "BK-90210." is
 * 90210.
 */
function digitRuns(text: string): string[] {
  return text.match(/\d+(?:,\d{3})*(?:\.\d{1,2})?/g) ?? [];
}

/**
 * The strings a number is permitted to have come from. Each is either a field
 * of the validated decision or a field of the load record -- both authoritative
 * state, neither model output.
 */
function permittedNumberSources(facts: RenderFacts, extra: string[] = []): string[] {
  return [
    facts.load.loadId,
    formatWeight(facts.load.weightLbs),
    formatPickup(facts.load.pickupAt),
    formatMoney(facts.decision.linehaulCents),
    formatMoney(facts.decision.totalCents),
    ...facts.decision.accessorials.map((a) => formatMoney(a.amountCents)),
    facts.carrierName,
    ...extra,
  ];
}

function assertEveryNumberIsTraceable(body: string, facts: RenderFacts, extra: string[] = []) {
  const sources = permittedNumberSources(facts, extra);
  const untraceable = digitRuns(body).filter(
    (run) => !sources.some((source) => source.includes(run)),
  );
  expect(untraceable, `untraceable numbers in rendered body: ${untraceable.join(", ")}`).toEqual(
    [],
  );
}

describe("no number reaches a carrier except from validated state", () => {
  it("opening offer", () => {
    const { body } = renderOpeningOffer(FACTS);
    assertEveryNumberIsTraceable(body, FACTS);
  });

  it("counter offer", () => {
    const { body } = renderCounterOffer(FACTS);
    assertEveryNumberIsTraceable(body, FACTS);
  });

  it("acceptance", () => {
    const { body } = renderAcceptance(FACTS);
    assertEveryNumberIsTraceable(body, FACTS);
  });

  it("booking confirmation", () => {
    const reference = "BK-90210";
    const { body } = renderBookingConfirmation(FACTS, reference);
    assertEveryNumberIsTraceable(body, FACTS, [reference]);
  });

  it("with accessorials, every line traces back", () => {
    const facts: RenderFacts = {
      ...FACTS,
      decision: decision({
        linehaulCents: cents(180_000),
        accessorials: [detention],
        totalCents: cents(195_000),
      }),
    };
    const { body } = renderCounterOffer(facts);
    assertEveryNumberIsTraceable(body, facts);
    expect(body).toContain("$1,800.00");
    expect(body).toContain("$150.00");
    expect(body).toContain("$1,950.00");
  });

  it("catches a planted number, proving the test can fail", () => {
    const { body } = renderOpeningOffer(FACTS);
    const tampered = `${body}\nCall us on 555-0123 about a $2,400.00 rate.`;
    const sources = permittedNumberSources(FACTS);
    const untraceable = digitRuns(tampered).filter(
      (run) => !sources.some((source) => source.includes(run)),
    );
    expect(untraceable.length).toBeGreaterThan(0);
  });
});

describe("the renderer has no channel for model-authored text", () => {
  it("accepts no free-text field", () => {
    // Structural, not stylistic. If someone adds `note?: string` to RenderFacts,
    // this test still passes -- but the review conversation it forces is the
    // point, and the type is small enough that the addition is visible.
    const keys = Object.keys(FACTS).sort();
    expect(keys).toEqual(["brokerName", "carrierName", "decision", "load"]);
  });

  it("money always comes from the decision, never recomputed", () => {
    const facts: RenderFacts = {
      ...FACTS,
      // A total inconsistent with linehaul + accessorials. The renderer must
      // print what the engine decided, not silently correct it -- if these ever
      // disagree the bug is upstream and must stay visible.
      decision: decision({
        linehaulCents: cents(180_000),
        accessorials: [detention],
        totalCents: cents(195_000),
      }),
    };
    expect(renderAcceptance(facts).subject).toContain("$1,950.00");
  });
});

describe("formatting", () => {
  it("formats cents without floating point", () => {
    expect(formatMoney(cents(195_000))).toBe("$1,950.00");
    expect(formatMoney(cents(7_505))).toBe("$75.05");
    expect(formatMoney(cents(0))).toBe("$0.00");
    expect(formatMoney(cents(204_000))).toBe("$2,040.00");
  });

  it("formats pickup in UTC so CI and a laptop agree", () => {
    expect(formatPickup(new Date("2026-09-15T08:00:00Z"))).toBe("2026-09-15 at 08:00 UTC");
  });

  it("formats weight with a thousands separator", () => {
    expect(formatWeight(42_000)).toBe("42,000 lbs");
  });
});

describe("subjects and bodies", () => {
  it("threads a counter as a reply", () => {
    expect(renderCounterOffer(FACTS).subject.startsWith("Re: ")).toBe(true);
    expect(renderOpeningOffer(FACTS).subject.startsWith("Re: ")).toBe(false);
  });

  it("names the load in every subject", () => {
    for (const rendered of [
      renderOpeningOffer(FACTS),
      renderCounterOffer(FACTS),
      renderAcceptance(FACTS),
      renderBookingConfirmation(FACTS, "BK-1"),
    ]) {
      expect(rendered.subject).toContain("L-4471");
    }
  });

  it("is a pure function of its facts", () => {
    expect(renderOpeningOffer(FACTS)).toEqual(renderOpeningOffer(FACTS));
  });
});
