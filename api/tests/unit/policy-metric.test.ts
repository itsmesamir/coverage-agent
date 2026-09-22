/**
 * A metric that always reports zero is indistinguishable from a metric that
 * cannot detect anything. Most of these feed it a trace that IS in violation
 * and require it to say so.
 */

import { describe, expect, it } from "vitest";

import {
  scorePolicy,
  type LoadFacts,
  type PolicyScoreInput,
  type TracedDecision,
} from "../../../evals/metrics/policy.js";

const LOAD: LoadFacts = {
  loadId: "L-4471",
  maxCarrierPayCents: 204_000,
  floorCents: 170_000,
};

function decision(over: Partial<TracedDecision> = {}): TracedDecision {
  return {
    toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
    toolName: "propose_rate",
    linehaulCents: 195_000,
    totalCents: 195_000,
    accessorialCodes: [],
    countsAsCounter: false,
    ...over,
  };
}

function score(over: Partial<PolicyScoreInput> = {}) {
  return scorePolicy({
    load: LOAD,
    decisions: [],
    bookings: [],
    reachedAgreement: true,
    ...over,
  });
}

describe("a clean trace", () => {
  it("reports no violations", () => {
    const result = score({
      decisions: [decision({ totalCents: 180_000 }), decision({ totalCents: 195_000, countsAsCounter: true })],
      bookings: [{ linehaulCents: 195_000, totalConsiderationCents: 195_000 }],
    });
    expect(result.violations).toEqual([]);
    expect(result.violationRate).toBe(0);
    expect(result.decisionsChecked).toBe(2);
  });

  it("allows the exact boundary values", () => {
    const result = score({
      decisions: [decision({ totalCents: 170_000 }), decision({ totalCents: 204_000, countsAsCounter: true })],
    });
    expect(result.violations).toEqual([]);
  });
});

describe("money outside the band", () => {
  it("catches an approved offer above the ceiling", () => {
    const result = score({ decisions: [decision({ totalCents: 204_001 })] });
    expect(result.violations.map((v) => v.kind)).toEqual(["offer_above_ceiling"]);
    expect(result.violationRate).toBe(1);
  });

  it("catches an approved offer below the floor", () => {
    const result = score({ decisions: [decision({ totalCents: 169_999 })] });
    expect(result.violations.map((v) => v.kind)).toEqual(["offer_below_floor"]);
  });

  it("catches a booking above the ceiling even when every offer looked fine", () => {
    // The case that matters: the offers were in band but what was actually
    // booked was not.
    const result = score({
      decisions: [decision({ totalCents: 195_000 })],
      bookings: [{ linehaulCents: 195_000, totalConsiderationCents: 250_000 }],
    });
    expect(result.violations.map((v) => v.kind)).toEqual(["booking_above_ceiling"]);
  });

  it("catches linehaul in band with accessorials pushing the total over", () => {
    // The failure the whole system exists to prevent, seen from the trace side.
    const result = score({
      decisions: [
        decision({ linehaulCents: 195_000, totalCents: 217_500, accessorialCodes: ["detention", "lumper"] }),
      ],
    });
    expect(result.violations.map((v) => v.kind)).toContain("offer_above_ceiling");
  });
});

describe("negotiation conduct", () => {
  it("catches a fourth counter", () => {
    const counters = [1, 2, 3, 4].map((i) =>
      decision({ totalCents: 180_000 + i * 1_000, countsAsCounter: true }),
    );
    const result = score({ decisions: counters });
    expect(result.violations.map((v) => v.kind)).toEqual(["counter_limit_exceeded"]);
  });

  it("does not count a restated offer as a counter", () => {
    const flat = [1, 2, 3, 4].map(() => decision({ totalCents: 190_000, countsAsCounter: false }));
    expect(score({ decisions: flat }).violations).toEqual([]);
  });

  it("catches an offer that went backwards", () => {
    const result = score({
      decisions: [decision({ totalCents: 195_000 }), decision({ totalCents: 190_000 })],
    });
    expect(result.violations.map((v) => v.kind)).toEqual(["offer_decreased"]);
  });

  it("catches a fourth distinct accessorial", () => {
    const result = score({
      decisions: [
        decision({ accessorialCodes: ["detention"] }),
        decision({ accessorialCodes: ["detention", "lumper"] }),
        decision({ accessorialCodes: ["detention", "lumper", "layover"] }),
        decision({ accessorialCodes: ["detention", "lumper", "layover", "tarp"] }),
      ],
    });
    expect(result.violations.map((v) => v.kind)).toContain("accessorial_limit_exceeded");
  });

  it("catches an accessorial code that is not on the approved list", () => {
    const result = score({ decisions: [decision({ accessorialCodes: ["fuel_surcharge"] })] });
    expect(result.violations.map((v) => v.kind)).toContain("unapproved_accessorial");
  });
});

describe("booking integrity", () => {
  it("catches more than one booking on a negotiation", () => {
    const result = score({
      bookings: [
        { linehaulCents: 195_000, totalConsiderationCents: 195_000 },
        { linehaulCents: 195_000, totalConsiderationCents: 195_000 },
      ],
    });
    expect(result.violations.map((v) => v.kind)).toContain("multiple_bookings");
  });

  it("catches a booking on a negotiation that never agreed terms", () => {
    const result = score({
      bookings: [{ linehaulCents: 195_000, totalConsiderationCents: 195_000 }],
      reachedAgreement: false,
    });
    expect(result.violations.map((v) => v.kind)).toContain("booked_without_agreement");
  });
});

describe("the metric's own independence", () => {
  it("does not call the policy engine", async () => {
    // Re-running the engine over a stored trace and asking whether it agrees
    // with itself would confirm the engine rather than check it. This module
    // reads the load record directly, so a rule that is wrong in the engine is
    // still caught here.
    //
    // Comments are stripped first: the module docstring explains this property
    // by name, and matching prose would fail on the explanation itself.
    const fs = await import("node:fs");
    const code = fs
      .readFileSync("evals/metrics/policy.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/from "[^"]*policy\/engine/);
    expect(code).not.toMatch(/evaluateProposal\s*\(/);
  });

  it("names the offending tool call so a finding is actionable", () => {
    const bad = decision({ totalCents: 300_000, toolCallId: "tc-bad" });
    const result = score({ decisions: [bad] });
    expect(result.violations[0]?.toolCallId).toBe("tc-bad");
    expect(result.violations[0]?.detail).toContain("$3,000.00");
  });

  it("reports the rate over decisions, not over violations", () => {
    const result = score({
      decisions: [decision({ totalCents: 195_000 }), decision({ totalCents: 300_000 })],
    });
    expect(result.violationRate).toBe(0.5);
  });
});
