/**
 * The distribution spec, as assertions. Written down as tests so the shapes
 * cannot drift silently -- if someone later swaps a Pareto for a uniform,
 * precision@5 quietly becomes meaningless and nothing else in the suite
 * would notice.
 */

import { describe, expect, it } from "vitest";
import type { Equipment } from "../../app/domain/equipment.js";
import { CARRIER_COUNT, generateDataset } from "../../../seed/generators.js";
import { BY_NAME, MAJOR_CORRIDORS, laneMarketRateCents } from "../../../seed/geography.js";

// Local wall-clock construction, not a UTC instant. Month is 0-indexed.
const NOW = new Date(2026, 8, 14, 9, 0);

const dataset = generateDataset(NOW);

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function pstdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// --- determinism -------------------------------------------------------

describe("determinism", () => {
  it("the same seed produces identical output", () => {
    expect(generateDataset(NOW, 7)).toEqual(generateDataset(NOW, 7));
  });

  it("a different seed produces different output", () => {
    expect(generateDataset(NOW, 7)).not.toEqual(generateDataset(NOW, 8));
  });

  it("has no hidden clock read: a different `now` moves pickup times and nothing else", () => {
    const other = generateDataset(new Date(2030, 0, 1, 0, 0));
    expect(other.carriers).toEqual(dataset.carriers);
    expect(other.lanes).toEqual(dataset.lanes);
    expect(other.loads).not.toEqual(dataset.loads);
  });
});

// --- carrier population --------------------------------------------------

describe("carrier population", () => {
  it("generates two hundred carriers", () => {
    expect(dataset.carriers).toHaveLength(CARRIER_COUNT);
    expect(new Set(dataset.carriers.map((c) => c.carrierId)).size).toBe(CARRIER_COUNT);
  });

  it("exactly 8% have inactive authority (16 of 200, an exact count not a coin flip)", () => {
    const inactive = dataset.carriers.filter((c) => !c.authorityActive).length;
    expect(inactive).toBe(Math.round(CARRIER_COUNT * 0.08));
    expect(inactive).toBe(16);
  });

  it("authority is uncorrelated with service quality", () => {
    const active = dataset.carriers.filter((c) => c.authorityActive).map((c) => c.onTimeBps);
    const inactive = dataset.carriers.filter((c) => !c.authorityActive).map((c) => c.onTimeBps);
    expect(Math.abs(mean(active) - mean(inactive))).toBeLessThan(300); // under 3 points
  });

  it("on-time is skewed high with a left tail", () => {
    const pct = dataset.carriers.map((c) => c.onTimeBps / 100);
    expect(median(pct)).toBeGreaterThanOrEqual(88);
    expect(median(pct)).toBeLessThanOrEqual(95);
    expect(Math.max(...pct)).toBeLessThanOrEqual(99);
    // No left tail would mean every carrier looks good, so ranking is trivial.
    expect(Math.min(...pct)).toBeLessThan(82);
  });

  it("fleet size follows a power law", () => {
    const sizes = dataset.carriers.map((c) => c.fleetSize);
    expect(sizes.filter((s) => s < 20).length / sizes.length).toBeGreaterThanOrEqual(0.93);
    expect(median(sizes)).toBeLessThanOrEqual(5);
    // No large carriers would mean the tail is missing.
    expect(Math.max(...sizes)).toBeGreaterThan(50);
  });

  it("equipment mix is roughly 60/20/15/5", () => {
    const n = dataset.carriers.length;
    const mix: Record<Equipment, number> = { dry_van: 0, reefer: 0, flatbed: 0, specialized: 0 };
    for (const c of dataset.carriers) mix[c.equipment[0] as Equipment]++;
    expect(mix.dry_van / n).toBeGreaterThanOrEqual(0.52);
    expect(mix.dry_van / n).toBeLessThanOrEqual(0.68);
    expect(mix.reefer / n).toBeGreaterThanOrEqual(0.13);
    expect(mix.reefer / n).toBeLessThanOrEqual(0.27);
    expect(mix.flatbed / n).toBeGreaterThanOrEqual(0.09);
    expect(mix.flatbed / n).toBeLessThanOrEqual(0.21);
    expect(mix.specialized / n).toBeGreaterThanOrEqual(0.01);
    expect(mix.specialized / n).toBeLessThanOrEqual(0.10);
  });

  it("carriers hold one or two equipment types", () => {
    expect(dataset.carriers.every((c) => c.equipment.length >= 1 && c.equipment.length <= 2)).toBe(true);
  });
});

// --- lane history --------------------------------------------------------

describe("lane history", () => {
  it("loads-per-lane follows a power law", () => {
    const runs = dataset.lanes.map((l) => l.loadsRun);
    expect(runs.filter((r) => r >= 1 && r <= 5).length / runs.length).toBeGreaterThanOrEqual(0.75);
    // No deep relationships would mean lane familiarity cannot matter.
    expect(Math.max(...runs)).toBeGreaterThanOrEqual(50);
  });

  it("lanes concentrate near the carrier's home region", () => {
    const home = new Map(dataset.carriers.map((c) => [c.carrierId, c.homeRegion]));
    const atHome = dataset.lanes.filter(
      (l) => BY_NAME.get(l.origin)?.region === home.get(l.carrierId),
    ).length;
    expect(atHome / dataset.lanes.length).toBeGreaterThanOrEqual(0.6);
  });

  it("freight concentrates on major corridors", () => {
    // Volume is not spread evenly over every city pair. Without this, any one
    // lane is too thin to rank on and retrieval eval has nothing to measure.
    const counts = new Map<string, number>();
    for (const l of dataset.lanes) {
      const key = `${l.origin}|${l.destination}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
    const corridors = new Set(MAJOR_CORRIDORS.map((c) => `${c.origin}|${c.destination}`));
    expect(busiest.filter((pair) => corridors.has(pair)).length).toBeGreaterThanOrEqual(8);
  });

  it("the reference lane has a rankable cohort", () => {
    // Chicago->Dallas must carry enough bookable carriers that choosing a top
    // 5 is a real ranking problem, not "return everyone who qualifies".
    const active = new Set(dataset.carriers.filter((c) => c.authorityActive).map((c) => c.carrierId));
    const eligible = dataset.lanes.filter(
      (l) =>
        l.origin === "Chicago, IL" &&
        l.destination === "Dallas, TX" &&
        l.equipment === "dry_van" &&
        active.has(l.carrierId),
    );
    expect(eligible.length).toBeGreaterThanOrEqual(8);
    // And they must not all look alike, or ranking them is arbitrary.
    expect(new Set(eligible.map((l) => l.loadsRun)).size).toBeGreaterThanOrEqual(3);
  });

  it("carriers only run lanes with equipment they own", () => {
    const owned = new Map(dataset.carriers.map((c) => [c.carrierId, new Set(c.equipment)]));
    expect(dataset.lanes.every((l) => owned.get(l.carrierId)?.has(l.equipment))).toBe(true);
  });
});

// --- the signal the reranker exists to find ------------------------------

function rateRatios(): { strong: number[]; rest: number[] } {
  const onTime = new Map(dataset.carriers.map((c) => [c.carrierId, c.onTimeBps]));
  const strong: number[] = [];
  const rest: number[] = [];
  for (const lane of dataset.lanes) {
    const market = laneMarketRateCents(BY_NAME.get(lane.origin)!, BY_NAME.get(lane.destination)!, lane.equipment);
    const ratio = lane.lastRateCents / market;
    const deepAndReliable = lane.loadsRun >= 10 && (onTime.get(lane.carrierId) ?? 0) >= 9000;
    (deepAndReliable ? strong : rest).push(ratio);
  }
  return { strong, rest };
}

describe("the signal the reranker exists to find", () => {
  it("familiar, reliable carriers accept less", () => {
    // The correlation the reranker is supposed to exploit. Without it,
    // ranking by lane familiarity would be superstition.
    const { strong, rest } = rateRatios();
    expect(mean(strong)).toBeLessThan(mean(rest) - 0.02);
  });

  it("the signal does not separate cleanly (counter-trap)", () => {
    // Rate noise (8-12%) deliberately exceeds the familiarity discount (max
    // 6%), so the groups overlap. A metric pinned at 1.0 measures nothing.
    const { strong, rest } = rateRatios();
    expect(Math.min(...rest)).toBeLessThan(Math.max(...strong));
    expect(pstdev(rest)).toBeGreaterThan(mean(rest) - mean(strong));
  });
});

// --- money and the reference load -----------------------------------------

describe("money and the reference load", () => {
  it("all money is an integer", () => {
    for (const lane of dataset.lanes) {
      expect(Number.isInteger(lane.lastRateCents)).toBe(true);
    }
    for (const load of dataset.loads) {
      expect(Number.isInteger(load.customerRateCents)).toBe(true);
      expect(Number.isInteger(load.maxCarrierPayCents)).toBe(true);
      expect(Number.isInteger(load.floorCents)).toBe(true);
    }
  });

  it("the reference load matches CLAUDE.md exactly", () => {
    const load = dataset.loads.find((x) => x.loadId === "L-4471");
    expect(load).toBeDefined();
    expect(load!.origin).toBe("Chicago, IL");
    expect(load!.destination).toBe("Dallas, TX");
    expect(load!.equipment).toBe("dry_van");
    expect(load!.weightLbs).toBe(42_000);
    expect(load!.customerRateCents).toBe(240_000);
    expect(load!.targetMarginBps).toBe(1500);
    expect(load!.maxCarrierPayCents).toBe(204_000);
    expect(load!.floorCents).toBe(170_000);
    expect(load!.pickupAt).toEqual(new Date(2026, 8, 15, 8, 0));
  });

  it("every load has a coherent rate band", () => {
    for (const load of dataset.loads) {
      expect(load.floorCents).toBeLessThan(load.maxCarrierPayCents);
      expect(load.maxCarrierPayCents).toBeLessThan(load.customerRateCents);
    }
  });
});
