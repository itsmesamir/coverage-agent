import { describe, expect, it } from "vitest";

import type { Equipment } from "../../app/domain/equipment.js";
import {
  FAMILIARITY_SATURATION_LOADS,
  RECENCY_HORIZON_DAYS,
  WEIGHTS,
  isBookable,
  rerank,
  score,
  scoreBreakdown,
  usableTrailer,
  type RerankCandidate,
  type RerankContext,
} from "../../app/retrieval/rerank.js";

const CONTEXT: RerankContext = {
  requiredEquipment: "dry_van",
  weightLbs: 42_000,
  marketRateCents: 198_551, // Chicago -> Dallas mid-market, from the seed geography
};

function candidate(over: Partial<RerankCandidate> = {}): RerankCandidate {
  return {
    carrierId: "C-1000",
    authorityActive: true,
    equipment: ["dry_van"] as readonly Equipment[],
    onTimeBps: 9000,
    ...over,
  };
}

describe("weights", () => {
  it("sum to one so a score reads as a fraction of the ideal carrier", () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("hard filters", () => {
  it("drops a carrier without active authority regardless of how good it looks", () => {
    const perfect = candidate({
      authorityActive: false,
      onTimeBps: 9900,
      laneLoadsRun: 50,
      laneLastRateCents: 150_000,
      laneLastRunDaysAgo: 1,
    });
    expect(isBookable(perfect, CONTEXT)).toBe(false);
    expect(rerank([perfect], CONTEXT)).toEqual([]);
  });

  it("drops a carrier whose equipment cannot haul the freight", () => {
    const flatbed = candidate({ equipment: ["flatbed"] });
    expect(rerank([flatbed], CONTEXT)).toEqual([]);
  });

  it("drops a carrier whose trailer is type-permitted but too light", () => {
    // A reefer may haul dry freight, but caps at 43,500 lbs.
    const heavy: RerankContext = { ...CONTEXT, weightLbs: 44_000 };
    expect(rerank([candidate({ equipment: ["reefer"] })], heavy)).toEqual([]);
    // The same carrier is fine on the lighter reference load.
    expect(rerank([candidate({ equipment: ["reefer"] })], CONTEXT)).toHaveLength(1);
  });

  it("keeps a carrier that owns one usable trailer among several", () => {
    const mixed = candidate({ equipment: ["flatbed", "dry_van"] });
    expect(usableTrailer(mixed, CONTEXT)).toBe("dry_van");
  });

  it("prefers an exact trailer over a legal substitute", () => {
    const both = candidate({ equipment: ["reefer", "dry_van"] });
    expect(usableTrailer(both, CONTEXT)).toBe("dry_van");
  });
});

describe("signal normalisation", () => {
  it("lane familiarity saturates rather than growing without bound", () => {
    const at = scoreBreakdown(
      candidate({ laneLoadsRun: FAMILIARITY_SATURATION_LOADS }),
      CONTEXT,
      "dry_van",
    );
    const far = scoreBreakdown(candidate({ laneLoadsRun: 500 }), CONTEXT, "dry_van");
    expect(at.laneFamiliarity).toBe(1);
    expect(far.laneFamiliarity).toBe(1);
  });

  it("a carrier with no history on the lane scores zero familiarity, not negative", () => {
    const b = scoreBreakdown(candidate(), CONTEXT, "dry_van");
    expect(b.laneFamiliarity).toBe(0);
    expect(b.recency).toBe(0);
  });

  it("an unknown rate scores neutral, not zero", () => {
    // No evidence is not the same as evidence of a bad price. Scoring it zero
    // would make every carrier new to the lane unrankable against one bad quote.
    const unknown = scoreBreakdown(candidate(), CONTEXT, "dry_van");
    expect(unknown.rateAdvantage).toBe(0.5);
  });

  it("a rate at market scores neutral and below market scores higher", () => {
    const atMarket = scoreBreakdown(
      candidate({ laneLastRateCents: CONTEXT.marketRateCents }),
      CONTEXT,
      "dry_van",
    );
    const cheap = scoreBreakdown(candidate({ laneLastRateCents: 170_000 }), CONTEXT, "dry_van");
    const dear = scoreBreakdown(candidate({ laneLastRateCents: 230_000 }), CONTEXT, "dry_van");
    expect(atMarket.rateAdvantage).toBeCloseTo(0.5, 6);
    expect(cheap.rateAdvantage).toBeGreaterThan(atMarket.rateAdvantage);
    expect(dear.rateAdvantage).toBeLessThan(atMarket.rateAdvantage);
  });

  it("clips absurd rates so one outlier cannot dominate the ranking", () => {
    const free = scoreBreakdown(candidate({ laneLastRateCents: 1 }), CONTEXT, "dry_van");
    const cheap = scoreBreakdown(candidate({ laneLastRateCents: 150_000 }), CONTEXT, "dry_van");
    expect(free.rateAdvantage).toBe(1);
    expect(cheap.rateAdvantage).toBe(1);
  });

  it("recency decays to zero at the horizon", () => {
    const today = scoreBreakdown(candidate({ laneLastRunDaysAgo: 0 }), CONTEXT, "dry_van");
    const old = scoreBreakdown(
      candidate({ laneLastRunDaysAgo: RECENCY_HORIZON_DAYS }),
      CONTEXT,
      "dry_van",
    );
    const ancient = scoreBreakdown(candidate({ laneLastRunDaysAgo: 900 }), CONTEXT, "dry_van");
    expect(today.recency).toBe(1);
    expect(old.recency).toBe(0);
    expect(ancient.recency).toBe(0);
  });

  it("on-time maps 80 percent to zero and 99 percent to one", () => {
    expect(scoreBreakdown(candidate({ onTimeBps: 8000 }), CONTEXT, "dry_van").onTime).toBe(0);
    expect(scoreBreakdown(candidate({ onTimeBps: 9900 }), CONTEXT, "dry_van").onTime).toBe(1);
    expect(scoreBreakdown(candidate({ onTimeBps: 7000 }), CONTEXT, "dry_van").onTime).toBe(0);
  });

  it("penalises a substitute trailer against an exact match", () => {
    const exact = scoreBreakdown(candidate(), CONTEXT, "dry_van");
    const substitute = scoreBreakdown(candidate(), CONTEXT, "reefer");
    expect(exact.equipmentMatch).toBe(1);
    expect(substitute.equipmentMatch).toBe(0.5);
  });

  it("every signal stays within zero and one", () => {
    const extremes: RerankCandidate[] = [
      candidate({ onTimeBps: 0, laneLoadsRun: 0, laneLastRateCents: 0, laneLastRunDaysAgo: 0 }),
      candidate({
        onTimeBps: 10_000,
        laneLoadsRun: 9_999,
        laneLastRateCents: 9_999_999,
        laneLastRunDaysAgo: 9_999,
      }),
    ];
    for (const c of extremes) {
      for (const value of Object.values(scoreBreakdown(c, CONTEXT, "dry_van"))) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("ordering", () => {
  it("ranks a deep, reliable, cheap, recent carrier above a stranger", () => {
    const strong = candidate({
      carrierId: "C-STRONG",
      onTimeBps: 9600,
      laneLoadsRun: 14,
      laneLastRateCents: 180_000,
      laneLastRunDaysAgo: 10,
    });
    const stranger = candidate({ carrierId: "C-NEW", onTimeBps: 9000 });
    const [first] = rerank([stranger, strong], CONTEXT);
    expect(first?.carrierId).toBe("C-STRONG");
  });

  it("breaks ties deterministically on carrier id", () => {
    const a = candidate({ carrierId: "C-2000" });
    const b = candidate({ carrierId: "C-1000" });
    expect(rerank([a, b], CONTEXT).map((r) => r.carrierId)).toEqual(["C-1000", "C-2000"]);
    expect(rerank([b, a], CONTEXT).map((r) => r.carrierId)).toEqual(["C-1000", "C-2000"]);
  });

  it("returns at most the requested limit", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      candidate({ carrierId: `C-${2000 + i}`, onTimeBps: 8500 + i }),
    );
    expect(rerank(many, CONTEXT)).toHaveLength(5);
    expect(rerank(many, CONTEXT, 3)).toHaveLength(3);
  });

  it("is a pure function of its inputs", () => {
    const input = [candidate({ carrierId: "C-1", laneLoadsRun: 3 }), candidate({ carrierId: "C-2" })];
    const frozen = JSON.stringify(input);
    expect(rerank(input, CONTEXT)).toEqual(rerank(input, CONTEXT));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("scores a perfect carrier at 1 and a minimal one above 0", () => {
    const perfect = candidate({
      onTimeBps: 9900,
      laneLoadsRun: 20,
      laneLastRateCents: 150_000,
      laneLastRunDaysAgo: 0,
    });
    const [best] = rerank([perfect], CONTEXT);
    expect(best?.score).toBeCloseTo(1, 6);
    expect(score(scoreBreakdown(candidate({ onTimeBps: 8000 }), CONTEXT, "dry_van"))).toBeGreaterThan(0);
  });

  it("the breakdown explains the score", () => {
    const [top] = rerank([candidate({ laneLoadsRun: 10, laneLastRunDaysAgo: 30 })], CONTEXT);
    expect(top).toBeDefined();
    expect(score(top!.breakdown)).toBeCloseTo(top!.score, 10);
  });
});
