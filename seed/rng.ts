/**
 * A seeded PRNG plus the non-uniform distributions the generators need.
 *
 * `Math.random()` cannot be seeded, so reproducible synthetic data needs an
 * explicit generator: xoshiro128** (Blackman & Vigna's public-domain 32-bit
 * generator, https://prng.di.unimi.it/xoshiro128starstar.c), seeded via
 * splitmix32 so callers pass one integer seed rather than four.
 *
 * Each distribution is checked in seed/rng.test.ts against its closed-form
 * mean/variance/percentiles over tens of thousands of draws -- a stronger
 * check than "looks plausible": a wrong Beta implementation produces a
 * measurably wrong mean, not merely an unfamiliar one.
 */

function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

function xoshiro128ss(a: number, b: number, c: number, d: number): () => number {
  return () => {
    let r = Math.imul(b * 5, 1) | 0;
    r = (((r << 7) | (r >>> 25)) * 9) | 0;
    const t = (b << 9) | 0;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return (r >>> 0) / 4_294_967_296;
  };
}

/**
 * One RNG instance threaded through the whole generation run. Never use the
 * ambient `Math.random` inside seed/ -- that would be a hidden clock read in
 * otherwise-deterministic code, and "deterministic given a seed" depends on
 * it not happening.
 */
export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    const seedWord = splitmix32(seed);
    this.next = xoshiro128ss(seedWord(), seedWord(), seedWord(), seedWord());
  }

  /** Uniform float in [0, 1). */
  random(): number {
    return this.next();
  }

  /** Uniform float in [a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** Uniform integer in [min, max], both inclusive. */
  randInt(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** One element, uniformly. */
  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("choice() from an empty array");
    return items[Math.floor(this.random() * items.length)] as T;
  }

  /**
   * One element chosen with probability proportional to `weights`. Walks the
   * cumulative distribution against a single uniform draw -- a linear scan
   * rather than a binary search over a precomputed cumulative array, which is
   * fine at this size and simpler to read.
   */
  weightedChoice<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length !== weights.length) {
      throw new RangeError("weightedChoice: items and weights must be the same length");
    }
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = this.uniform(0, total);
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i] as number;
      if (roll <= 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /**
   * `k` distinct elements, without replacement, order not meaningful. Partial
   * Fisher-Yates: swap a random remaining element into position `i`, k times.
   * O(k) swaps rather than shuffling the whole array.
   */
  sample<T>(population: readonly T[], k: number): T[] {
    if (k > population.length) {
      throw new RangeError(`sample: k=${k} exceeds population size ${population.length}`);
    }
    const pool = [...population];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(this.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
    }
    return pool.slice(0, k);
  }

  /**
   * Standard Gamma(shape, scale). Marsaglia & Tsang (2000), the standard
   * rejection-sampling method for shape >= 1; for shape < 1 it generates
   * Gamma(shape + 1, 1) and rescales by U^(1/shape) (Ahrens-Dieter boost, the
   * usual trick to extend Marsaglia-Tsang below 1). Only shape=2 and shape=9
   * are used by this codebase (Beta(2,9) below), but the boost is included so
   * this function is correct for any shape a future caller passes it, not
   * just the two values exercised today.
   */
  gamma(shape: number, scale = 1): number {
    if (shape < 1) {
      const u = this.random();
      return this.gamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.gaussian(0, 1);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /** Beta(a, b) via two independent Gamma draws: X/(X+Y), X~Gamma(a), Y~Gamma(b). */
  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x === 0 && y === 0 ? 0 : x / (x + y);
  }

  /**
   * Standard normal via Box-Muller, scaled to N(mu, sigma). A cheaper variant
   * caches the second value the transform produces; not done here for
   * simplicity, and generator throughput was never the bottleneck (seeding
   * 200 carriers takes single-digit milliseconds either way).
   */
  gaussian(mu: number, sigma: number): number {
    const u1 = Math.max(this.random(), Number.EPSILON); // guard log(0)
    const u2 = this.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z;
  }

  /**
   * Pareto (Type I), minimum value 1. Inverse-CDF: `1 / U^(1/alpha)` for
   * U uniform on (0, 1].
   */
  pareto(alpha: number): number {
    const u = 1 - this.random(); // exclude 0: U^(-1/alpha) blows up at U=0
    return Math.pow(u, -1 / alpha);
  }

  /** Exponential with rate `lambda`. Inverse-CDF: `-ln(1 - U) / lambda`. */
  exponential(lambda: number): number {
    return -Math.log(1 - this.random()) / lambda;
  }
}
