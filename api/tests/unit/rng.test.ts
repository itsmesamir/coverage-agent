/**
 * Distribution-shape verification for seed/rng.ts.
 *
 * There is no byte-for-byte target here (see the module doc in rng.ts for
 * why). Instead: draw a large sample from each distribution and check the
 * empirical moments against the closed-form values. A wrong implementation
 * produces a measurably wrong mean or spread, not merely an unfamiliar one --
 * that is what makes this a real verification and not a vibe check.
 */

import { describe, expect, it } from "vitest";
import { Rng } from "../../../seed/rng.js";

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const N = 50_000;

describe("determinism (the property that actually matters)", () => {
  it("the same seed reproduces the same stream", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const draws = Array.from({ length: 20 }, () => a.random());
    const repeat = Array.from({ length: 20 }, () => b.random());
    expect(repeat).toEqual(draws);
  });

  it("different seeds diverge immediately", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.random()).not.toBe(b.random());
  });

  it("random() never returns exactly 1", () => {
    const rng = new Rng(7);
    for (let i = 0; i < N; i++) {
      expect(rng.random()).toBeLessThan(1);
      expect(rng.random()).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("uniform(0, 1)", () => {
  const rng = new Rng(1);
  const xs = Array.from({ length: N }, () => rng.random());

  it("mean ~= 0.5 (theoretical variance of the mean is 1/(12N), so 3 sd is a tight band)", () => {
    const sdOfMean = Math.sqrt(1 / 12 / N);
    expect(Math.abs(mean(xs) - 0.5)).toBeLessThan(3 * sdOfMean);
  });

  it("variance ~= 1/12", () => {
    expect(variance(xs)).toBeCloseTo(1 / 12, 2);
  });

  it("covers the full range roughly evenly (deciles within 20% of expected count)", () => {
    const buckets = new Array(10).fill(0);
    for (const x of xs) buckets[Math.min(9, Math.floor(x * 10))]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan((N / 10) * 0.8);
      expect(count).toBeLessThan((N / 10) * 1.2);
    }
  });
});

describe("gaussian(mu, sigma)", () => {
  const rng = new Rng(2);
  const mu = 10;
  const sigma = 3;
  const xs = Array.from({ length: N }, () => rng.gaussian(mu, sigma));

  it("mean and variance match the parameters", () => {
    const sdOfMean = sigma / Math.sqrt(N);
    expect(Math.abs(mean(xs) - mu)).toBeLessThan(4 * sdOfMean);
    expect(variance(xs)).toBeCloseTo(sigma * sigma, 0);
  });

  it("is symmetric: equal mass above and below the mean", () => {
    const above = xs.filter((x) => x > mu).length;
    expect(above / N).toBeCloseTo(0.5, 1);
  });
});

describe("exponential(lambda)", () => {
  const rng = new Rng(3);
  const lambda = 1 / 45; // the value generators.ts uses for last-run recency
  const xs = Array.from({ length: N }, () => rng.exponential(lambda));

  it("mean ~= 1/lambda", () => {
    const theoreticalMean = 1 / lambda;
    const sdOfMean = theoreticalMean / Math.sqrt(N);
    expect(Math.abs(mean(xs) - theoreticalMean)).toBeLessThan(4 * sdOfMean);
  });

  it("median ~= ln(2)/lambda", () => {
    expect(median(xs)).toBeCloseTo(Math.log(2) / lambda, -1);
  });

  it("is memoryless-shaped: P(X > 2*mean) ~= e^-2 regardless of the threshold", () => {
    const t = 1 / lambda;
    const beyond = xs.filter((x) => x > 2 * t).length / N;
    expect(beyond).toBeCloseTo(Math.exp(-2), 1);
  });
});

describe("pareto(alpha)", () => {
  // alpha=1.15 is what generators.ts uses for fleet size -- heavy-tailed
  // enough that the mean is dominated by rare huge draws, so the median (a
  // closed form, 2^(1/alpha)) is the honest statistic to check, not the mean.
  const alpha = 1.15;
  const rng = new Rng(4);
  const xs = Array.from({ length: N }, () => rng.pareto(alpha));

  it("median ~= 2^(1/alpha)", () => {
    expect(median(xs)).toBeCloseTo(Math.pow(2, 1 / alpha), 1);
  });

  it("P(X > x) ~= x^-alpha (the defining property of a power law)", () => {
    for (const x of [2, 5, 10]) {
      const theoretical = Math.pow(x, -alpha);
      const empirical = xs.filter((v) => v > x).length / N;
      expect(Math.abs(empirical - theoretical)).toBeLessThan(0.02);
    }
  });

  it("produces a real tail: at least one draw far past the median", () => {
    // This is the property the fleet-size and loads-per-lane distributions
    // actually depend on -- see test_seed_generators for "max() > 50".
    expect(Math.max(...xs)).toBeGreaterThan(20);
  });

  it("never returns less than 1", () => {
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1);
  });
});

describe("beta(2, 9) -- the on-time-percentage shape", () => {
  const rng = new Rng(5);
  const xs = Array.from({ length: N }, () => rng.beta(2, 9));
  const a = 2;
  const b = 9;
  const theoreticalMean = a / (a + b); // 0.1818...
  const theoreticalVar = (a * b) / ((a + b) ** 2 * (a + b + 1)); // 0.01239...

  it("mean matches a/(a+b)", () => {
    const sdOfMean = Math.sqrt(theoreticalVar / N);
    expect(Math.abs(mean(xs) - theoreticalMean)).toBeLessThan(4 * sdOfMean);
  });

  it("variance matches ab/((a+b)^2(a+b+1))", () => {
    expect(variance(xs)).toBeCloseTo(theoreticalVar, 2);
  });

  it("is bounded to [0, 1] and right-skewed (mean > median)", () => {
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
    expect(mean(xs)).toBeGreaterThan(median(xs));
  });
});

describe("weightedChoice", () => {
  it("selects in proportion to weight, not uniformly", () => {
    const rng = new Rng(6);
    const items = ["a", "b", "c"] as const;
    const weights = [70, 20, 10];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < N; i++) {
      counts[rng.weightedChoice(items, weights)]!++;
    }
    expect(counts["a"]! / N).toBeCloseTo(0.7, 1);
    expect(counts["b"]! / N).toBeCloseTo(0.2, 1);
    expect(counts["c"]! / N).toBeCloseTo(0.1, 1);
  });
});

describe("sample (without replacement)", () => {
  const rng = new Rng(8);

  it("never repeats an element and always returns k items", () => {
    for (let i = 0; i < 1000; i++) {
      const drawn = rng.sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
      expect(drawn).toHaveLength(4);
      expect(new Set(drawn).size).toBe(4);
    }
  });

  it("covers every element roughly equally over many draws", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < N; i++) {
      for (const x of rng.sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)) {
        counts[x]++;
      }
    }
    const expected = (N * 3) / 10;
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.9);
      expect(c).toBeLessThan(expected * 1.1);
    }
  });
});
