/**
 * The deterministic half of the hallucination checker, plus the parsing that
 * guards it from a model returning something odd.
 *
 * These plant hallucinated claims and require detection. A checker that only
 * ever says "supported" against messages a template produced would look
 * excellent and prove nothing.
 */

import { describe, expect, it } from "vitest";

import {
  scoreHallucination,
  verifyClaim,
  type Claim,
  type GroundTruth,
} from "../../../evals/metrics/hallucination.js";
import { extractJsonObject, parseClaims } from "../../../evals/metrics/claim-extraction.js";

const TRUTH: GroundTruth = {
  loadId: "L-4471",
  origin: "Chicago, IL",
  destination: "Dallas, TX",
  equipment: "dry_van",
  weightLbs: 42_000,
  commodity: "general freight",
  pickupAt: new Date("2026-09-17T08:00:00Z"),
  carrierName: "Cedar Line Transport",
  approvedAmountsCents: [195_000, 15_000, 180_000],
};

const claim = (kind: Claim["kind"], value: Claim["value"], text = "x"): Claim => ({
  kind,
  text,
  value,
});

describe("money claims", () => {
  it("supports an amount the engine approved", () => {
    expect(verifyClaim(claim("money", 195_000), TRUTH).verdict).toBe("supported");
    expect(verifyClaim(claim("money", 15_000), TRUTH).verdict).toBe("supported");
  });

  it("catches an amount that was never approved", () => {
    // The hallucination that matters most: a price the carrier was quoted
    // that no decision ever authorised.
    const result = verifyClaim(claim("money", 240_000), TRUTH);
    expect(result.verdict).toBe("unsupported");
    expect(result.reason).toContain("240000");
  });

  it("catches an amount that is close but wrong", () => {
    expect(verifyClaim(claim("money", 195_001), TRUTH).verdict).toBe("unsupported");
  });
});

describe("load facts", () => {
  it("supports the real weight and catches a wrong one", () => {
    expect(verifyClaim(claim("weight", 42_000), TRUTH).verdict).toBe("supported");
    expect(verifyClaim(claim("weight", 44_000), TRUTH).verdict).toBe("unsupported");
  });

  it("supports the pickup to the minute", () => {
    expect(verifyClaim(claim("pickup", "2026-09-17T08:00:00Z"), TRUTH).verdict).toBe("supported");
    expect(verifyClaim(claim("pickup", "2026-09-17T08:00:30Z"), TRUTH).verdict).toBe("supported");
  });

  it("catches a pickup on the wrong day", () => {
    expect(verifyClaim(claim("pickup", "2026-09-18T08:00:00Z"), TRUTH).verdict).toBe("unsupported");
  });

  it("accepts human phrasing of equipment", () => {
    for (const written of ["dry van", "Dry Van", "dryvan"]) {
      expect(verifyClaim(claim("equipment", written), TRUTH).verdict, written).toBe("supported");
    }
  });

  it("catches the wrong equipment", () => {
    expect(verifyClaim(claim("equipment", "reefer"), TRUTH).verdict).toBe("unsupported");
  });

  it("checks origin, destination, commodity, load id and carrier", () => {
    expect(verifyClaim(claim("origin", "Chicago, IL"), TRUTH).verdict).toBe("supported");
    expect(verifyClaim(claim("destination", "Houston, TX"), TRUTH).verdict).toBe("unsupported");
    expect(verifyClaim(claim("commodity", "general freight"), TRUTH).verdict).toBe("supported");
    expect(verifyClaim(claim("load_id", "L-9999"), TRUTH).verdict).toBe("unsupported");
    expect(verifyClaim(claim("carrier", "Cedar Line Transport"), TRUTH).verdict).toBe("supported");
  });
});

describe("what the checker refuses to judge", () => {
  it("marks unverifiable statements ambiguous rather than guessing", () => {
    // Guessing at these is how an evaluator starts producing numbers nobody
    // can defend.
    expect(verifyClaim(claim("other", "we will move quickly"), TRUTH).verdict).toBe("ambiguous");
  });

  it("marks a claim with no extracted value ambiguous", () => {
    expect(verifyClaim(claim("money", null), TRUTH).verdict).toBe("ambiguous");
  });

  it("marks an unparsable date ambiguous rather than unsupported", () => {
    // "could not check" is not the same finding as "the agent lied".
    expect(verifyClaim(claim("pickup", "next Tuesday"), TRUTH).verdict).toBe("ambiguous");
  });
});

describe("the rate", () => {
  it("is zero when every settleable claim checks out", () => {
    const score = scoreHallucination(
      [claim("money", 195_000), claim("weight", 42_000), claim("other", "thanks")],
      TRUTH,
    );
    expect(score.rate).toBe(0);
    expect(score.supported).toBe(2);
    expect(score.ambiguous).toBe(1);
  });

  it("excludes ambiguous claims from the denominator", () => {
    // One wrong out of two settleable is 0.5, regardless of how many
    // unsettleable sentences surrounded them.
    const score = scoreHallucination(
      [
        claim("money", 195_000),
        claim("money", 999_999),
        claim("other", "a"),
        claim("other", "b"),
        claim("other", "c"),
      ],
      TRUTH,
    );
    expect(score.rate).toBe(0.5);
    expect(score.ambiguous).toBe(3);
  });

  it("is zero, not NaN, when nothing could be settled", () => {
    const score = scoreHallucination([claim("other", "hello")], TRUTH);
    expect(score.rate).toBe(0);
    expect(score.supported + score.unsupported).toBe(0);
  });
});

describe("parsing what a model returns", () => {
  it("reads a plain JSON object", () => {
    const claims = parseClaims('{"claims":[{"kind":"money","text":"$1,950.00","value":195000}]}');
    expect(claims).toHaveLength(1);
    expect(claims[0]?.value).toBe(195_000);
  });

  it("reads JSON wrapped in a fence", () => {
    const claims = parseClaims('```json\n{"claims":[{"kind":"weight","text":"42,000 lbs","value":42000}]}\n```');
    expect(claims[0]?.value).toBe(42_000);
  });

  it("reads JSON surrounded by prose", () => {
    const claims = parseClaims('Here you go:\n{"claims":[{"kind":"other","text":"hi","value":null}]}\nHope that helps.');
    expect(claims).toHaveLength(1);
  });

  it("coerces a numeric value the model sent as a string", () => {
    const claims = parseClaims('{"claims":[{"kind":"money","text":"$1,950.00","value":"195000"}]}');
    expect(claims[0]?.value).toBe(195_000);
  });

  it("returns nothing for unparsable output rather than throwing", () => {
    // A bad extraction must not take down a run.
    expect(parseClaims("I could not do that.")).toEqual([]);
    expect(parseClaims("{ not json")).toEqual([]);
    expect(parseClaims("")).toEqual([]);
  });

  it("drops a response whose shape does not validate", () => {
    expect(parseClaims('{"claims":[{"kind":"telepathy","text":"x","value":1}]}')).toEqual([]);
  });

  it("finds the object boundaries", () => {
    expect(extractJsonObject("junk {\"a\":1} junk")).toBe('{"a":1}');
    expect(extractJsonObject("no object here")).toBeNull();
  });
});
