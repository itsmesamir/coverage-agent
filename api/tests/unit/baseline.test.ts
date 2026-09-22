/**
 * The thresholds that fail a build.
 *
 * These matter more than most tests here: a regression gate that fails on
 * noise gets disabled, and one that passes on a real regression is worse than
 * having none at all.
 */

import { describe, expect, it } from "vitest";

import { THRESHOLDS, compareToBaseline, type Baseline } from "../../../evals/baseline.js";
import type { FixtureScore } from "../../../evals/score-fixture.js";

const BASELINE: Baseline = {
  recordedAt: "2026-09-17T00:00:00Z",
  gitSha: "abc1234",
  provider: "gemini",
  model: "gemini-3.6-flash",
  promptVersion: "v1",
  corpus: { traces: 16, decisionsChecked: 40, messagesWithClaims: 20 },
  metrics: { policyViolations: 0, meanToolCallScore: 1.0, hallucinationRate: 0.0 },
};

function score(over: Partial<FixtureScore> = {}): FixtureScore {
  return {
    traces: 16,
    decisionsChecked: 40,
    policyViolations: 0,
    violations: [],
    meanToolCallScore: 1.0,
    toolCallsScored: 16,
    hallucinationRate: 0.0,
    claimsSettleable: 100,
    claimsAmbiguous: 5,
    messagesWithClaims: 20,
    ...over,
  };
}

describe("policy violations", () => {
  it("passes at zero", () => {
    expect(compareToBaseline(score(), BASELINE).passed).toBe(true);
  });

  it("fails on a single violation, regardless of baseline", () => {
    // "Slightly more than zero" is not a weaker version of the claim; it is
    // the claim being false.
    const result = compareToBaseline(score({ policyViolations: 1 }), BASELINE);
    expect(result.passed).toBe(false);
    expect(result.breaches[0]?.metric).toBe("policy_violations");
  });
});

describe("tool-call score", () => {
  it("tolerates a drop inside the band", () => {
    expect(compareToBaseline(score({ meanToolCallScore: 0.985 }), BASELINE).passed).toBe(true);
  });

  it("fails on a drop beyond the band", () => {
    const result = compareToBaseline(score({ meanToolCallScore: 0.97 }), BASELINE);
    expect(result.passed).toBe(false);
    expect(result.breaches[0]?.metric).toBe("tool_call_score");
    expect(result.breaches[0]?.detail).toContain("0.9700");
  });

  it("never fails on an improvement", () => {
    // A build that breaks because the agent got better is a build people
    // learn to ignore.
    const result = compareToBaseline(score({ meanToolCallScore: 1.0 }), {
      ...BASELINE,
      metrics: { ...BASELINE.metrics, meanToolCallScore: 0.8 },
    });
    expect(result.passed).toBe(true);
    expect(result.notes.join(" ")).toContain("improved");
  });

  it("uses exactly the documented threshold", () => {
    expect(THRESHOLDS.toolCallScoreDrop).toBe(0.02);
    const atLimit = compareToBaseline(score({ meanToolCallScore: 1.0 - 0.02 }), BASELINE);
    expect(atLimit.passed).toBe(true);
  });
});

describe("hallucination rate", () => {
  it("tolerates a rise inside the band", () => {
    expect(compareToBaseline(score({ hallucinationRate: 0.005 }), BASELINE).passed).toBe(true);
  });

  it("fails on a rise beyond the band", () => {
    const result = compareToBaseline(score({ hallucinationRate: 0.05 }), BASELINE);
    expect(result.passed).toBe(false);
    expect(result.breaches[0]?.metric).toBe("hallucination_rate");
  });

  it("never fails on a fall", () => {
    expect(
      compareToBaseline(score({ hallucinationRate: 0 }), {
        ...BASELINE,
        metrics: { ...BASELINE.metrics, hallucinationRate: 0.2 },
      }).passed,
    ).toBe(true);
  });
});

describe("the corpus itself", () => {
  it("fails if the corpus shrank", () => {
    // Deleting the traces that were failing would otherwise read as a green
    // build -- the easiest way to defeat a regression check by accident.
    const result = compareToBaseline(score({ traces: 10 }), BASELINE);
    expect(result.passed).toBe(false);
    expect(result.breaches.map((b) => b.metric)).toContain("corpus_size");
  });

  it("passes on a larger corpus", () => {
    expect(compareToBaseline(score({ traces: 40 }), BASELINE).passed).toBe(true);
  });

  it("notes when claim coverage fell without failing the build", () => {
    // Worth seeing, but not worth blocking a merge: the rate still holds over
    // what it covered.
    const result = compareToBaseline(score({ messagesWithClaims: 5 }), BASELINE);
    expect(result.passed).toBe(true);
    expect(result.notes.join(" ")).toContain("covers less");
  });
});

describe("several regressions at once", () => {
  it("reports every breach, not just the first", () => {
    const result = compareToBaseline(
      score({ policyViolations: 2, meanToolCallScore: 0.5, hallucinationRate: 0.4 }),
      BASELINE,
    );
    expect(result.breaches.map((b) => b.metric).sort()).toEqual([
      "hallucination_rate",
      "policy_violations",
      "tool_call_score",
    ]);
  });
});
