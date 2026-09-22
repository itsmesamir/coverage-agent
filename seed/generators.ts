/**
 * Synthetic carrier, lane-history and load generation.
 *
 * Pure and deterministic: the same seed produces byte-identical output. No
 * database, no network, no clock read -- `now` is injected, the same
 * convention the policy engine uses, and for the same reason: it is what
 * lets `pnpm test` reproduce a specific dataset a bug report was filed
 * against, months later, on a different machine.
 *
 * Distribution shapes are deliberate. If every attribute were independent and
 * uniform, the reranker could not demonstrate value and precision@5 would be
 * noise measuring nothing.
 */

import type { Equipment } from "../api/app/domain/equipment.js";
import { MAJOR_CORRIDORS, METROS, getMetro, laneMarketRateCents, type Metro } from "./geography.js";
import type { CarrierLaneRecord, CarrierRecord, Dataset, LoadRecord } from "./records.js";
import { Rng } from "./rng.js";

export const DEFAULT_SEED = 20_260_915;
export const CARRIER_COUNT = 200;

// ~95% of US motor carriers run fewer than 20 trucks.
const FLEET_PARETO_ALPHA = 1.15;
const FLEET_MAX = 500;

// Most carrier/lane relationships are one or two loads; a few are deep.
const LANES_PER_CARRIER_ALPHA = 1.1;
const LANES_PER_CARRIER_MAX = 12;
const LOADS_PER_LANE_ALPHA = 1.2;
const LOADS_PER_LANE_MAX = 120;

const EQUIPMENT_MIX: readonly [Equipment, number][] = [
  ["dry_van", 60],
  ["reefer", 20],
  ["flatbed", 15],
  ["specialized", 5],
];
const SECOND_EQUIPMENT_PROB = 0.35;

// Share of lane history that sits on a major corridor rather than an
// arbitrary city pair. Corridor concentration is why a broker can find five
// credible carriers for Chicago->Dallas and almost none for Boise->Mobile.
const CORRIDOR_SHARE = 0.45;
const HOME_CORRIDOR_BOOST = 4;

// Exactly 8% of carriers, chosen uniformly at random. A fixed count keeps the
// fixture reproducible; uniform selection keeps authority independent of
// every quality signal, so it stays a real check and not a proxy for 'bad
// carrier'.
const INACTIVE_AUTHORITY_RATE = 0.08;

// A carrier deep on a lane with a good service record will take modestly
// less. This is the pattern the reranker exists to exploit. It is capped at
// 6% while per-lane rate noise runs 8-12%, so the signal is real but does not
// separate cleanly -- precision@5 must be able to move, not pin at 1.0.
const MAX_FAMILIARITY_DISCOUNT = 0.06;
const RATE_NOISE_MIN = 0.08;
const RATE_NOISE_MAX = 0.12;
const FAMILIARITY_SATURATION_LOADS = 20;

const COMMODITIES = [
  "general freight", "packaged foodstuffs", "paper goods", "auto parts",
  "building materials", "consumer electronics", "apparel", "plastics resin",
] as const;

function weightedMetro(rng: Rng, metros: readonly Metro[]): Metro {
  return rng.weightedChoice(metros, metros.map((m) => m.gravity));
}

function weightedEquipment(rng: Rng, options: readonly [Equipment, number][]): Equipment {
  return rng.weightedChoice(options.map(([e]) => e), options.map(([, w]) => w));
}

/**
 * Beta skewed high: most carriers 85-98%, with a left tail of bad ones.
 *
 * Beta(2, 9) is small and right-skewed, so subtracting it from a 98% ceiling
 * puts the mass just under the ceiling and stretches the tail downward.
 */
function onTimeBps(rng: Rng): number {
  const pct = 98.0 - 40.0 * rng.beta(2, 9);
  return Math.max(5000, Math.min(9900, Math.round(pct * 100)));
}

function fleetSize(rng: Rng): number {
  return Math.min(FLEET_MAX, Math.max(1, Math.floor(rng.pareto(FLEET_PARETO_ALPHA))));
}

function equipmentForCarrier(rng: Rng): Equipment[] {
  const primary = weightedEquipment(rng, EQUIPMENT_MIX);
  if (rng.random() >= SECOND_EQUIPMENT_PROB) return [primary];
  const remaining = EQUIPMENT_MIX.filter(([e]) => e !== primary);
  return [primary, weightedEquipment(rng, remaining)];
}

const NAME_FIRST = [
  "Ironwood", "Blue Ridge", "Vantage", "Cedar Line", "Northgate", "Sundial",
  "Copperfield", "Harbor Point", "Kestrel", "Granite Bay", "Longview",
  "Silver Fork", "Meridian", "Thornbury", "Fairweather", "Redstone",
] as const;
const NAME_LAST = [
  "Logistics", "Transport", "Carriers", "Freight Lines", "Trucking",
  "Haulage", "Motor Freight", "Express",
] as const;

function carrierName(rng: Rng, index: number): string {
  return `${rng.choice(NAME_FIRST)} ${rng.choice(NAME_LAST)} ${(index % 90) + 10}`;
}

export function generateCarriers(rng: Rng, count: number = CARRIER_COUNT): CarrierRecord[] {
  const inactiveCount = Math.round(count * INACTIVE_AUTHORITY_RATE);
  const inactive = new Set(rng.sample(Array.from({ length: count }, (_, i) => i), inactiveCount));

  const carriers: CarrierRecord[] = [];
  for (let i = 0; i < count; i++) {
    const home = rng.choice(METROS);
    carriers.push({
      carrierId: `C-${1000 + i}`,
      name: carrierName(rng, i),
      mcNumber: `MC-${600_000 + i * 7}`,
      dotNumber: `DOT-${3_000_000 + i * 13}`,
      authorityActive: !inactive.has(i),
      equipment: equipmentForCarrier(rng),
      fleetSize: fleetSize(rng),
      onTimeBps: onTimeBps(rng),
      homeRegion: home.region,
    });
  }
  return carriers;
}

/**
 * 0 to MAX_FAMILIARITY_DISCOUNT, rising with service quality AND depth.
 *
 * Both factors are required. A carrier who runs the lane constantly but is
 * unreliable gets no discount, and neither does a reliable stranger.
 */
function familiarityDiscount(onTime: number, loadsRun: number): number {
  const quality = Math.max(0, Math.min(1, (onTime - 8000) / 1900));
  const familiarity = Math.min(1, loadsRun / FAMILIARITY_SATURATION_LOADS);
  return MAX_FAMILIARITY_DISCOUNT * quality * familiarity;
}

export function generateCarrierLanes(rng: Rng, carriers: readonly CarrierRecord[]): CarrierLaneRecord[] {
  const byRegion = new Map<string, Metro[]>();
  for (const m of METROS) {
    const list = byRegion.get(m.region) ?? [];
    list.push(m);
    byRegion.set(m.region, list);
  }

  const lanes: CarrierLaneRecord[] = [];
  for (const carrier of carriers) {
    const laneCount = Math.min(
      LANES_PER_CARRIER_MAX,
      Math.max(1, Math.floor(rng.pareto(LANES_PER_CARRIER_ALPHA))),
    );
    const seen = new Set<string>();

    for (let i = 0; i < laneCount; i++) {
      let origin: Metro;
      let destination: Metro;

      // Lanes concentrate near home: a carrier's truck has to get back.
      if (rng.random() < CORRIDOR_SHARE) {
        // A Midwest carrier runs Chicago -> Dallas; a Seattle carrier does
        // not. Corridors concentrate volume, but a truck still has to start
        // from somewhere near home.
        const weights = MAJOR_CORRIDORS.map((c) =>
          getMetro(c.origin).region === carrier.homeRegion
            ? c.weight * HOME_CORRIDOR_BOOST
            : c.weight,
        );
        const chosen = rng.weightedChoice(MAJOR_CORRIDORS, weights);
        origin = getMetro(chosen.origin);
        destination = getMetro(chosen.destination);
      } else if (rng.random() < 0.8) {
        origin = weightedMetro(rng, byRegion.get(carrier.homeRegion) ?? METROS);
        destination = weightedMetro(rng, METROS);
      } else {
        origin = weightedMetro(rng, METROS);
        destination = weightedMetro(rng, METROS);
      }

      const key = `${origin.name}→${destination.name}`;
      if (origin === destination || seen.has(key)) continue;
      seen.add(key);

      const equipment = rng.choice(carrier.equipment);
      const loadsRun = Math.min(
        LOADS_PER_LANE_MAX,
        Math.max(1, Math.floor(rng.pareto(LOADS_PER_LANE_ALPHA))),
      );
      const market = laneMarketRateCents(origin, destination, equipment);
      const discount = familiarityDiscount(carrier.onTimeBps, loadsRun);
      const noise = rng.gaussian(1.0, rng.uniform(RATE_NOISE_MIN, RATE_NOISE_MAX));
      const rate = Math.round(market * (1.0 - discount) * Math.max(0.6, noise));

      lanes.push({
        carrierId: carrier.carrierId,
        origin: origin.name,
        destination: destination.name,
        equipment,
        loadsRun,
        lastRateCents: rate,
        lastRunDaysAgo: Math.min(365, Math.floor(rng.exponential(1 / 45)) + 1),
      });
    }
  }
  return lanes;
}

/** The load from CLAUDE.md. Numbers are fixed, not generated. */
export function referenceLoad(now: Date): LoadRecord {
  const pickup = new Date(now.getTime() + 24 * 3_600_000);
  pickup.setHours(8, 0, 0, 0);
  return {
    loadId: "L-4471",
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    weightLbs: 42_000,
    commodity: "general freight",
    pickupAt: pickup,
    customerRateCents: 240_000,
    targetMarginBps: 1500,
    maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  };
}

export function generateLoads(rng: Rng, now: Date, count = 12): LoadRecord[] {
  const loads: LoadRecord[] = [referenceLoad(now)];
  for (let i = 0; i < count; i++) {
    const [origin, destination] = rng.sample(METROS, 2) as [Metro, Metro];
    const equipment = weightedEquipment(rng, EQUIPMENT_MIX);
    const market = laneMarketRateCents(origin, destination, equipment);

    // The broker prices to the customer above market, then keeps a margin.
    const customerRate = Math.round((market * rng.uniform(1.14, 1.3)) / 100) * 100;
    const marginBps = rng.choice([1200, 1500, 1800]);
    const maxCarrierPay = Math.round((customerRate * (10_000 - marginBps)) / 10_000);

    loads.push({
      loadId: `L-${4500 + i}`,
      origin: origin.name,
      destination: destination.name,
      equipment,
      weightLbs: 500 * rng.randInt(16, 87), // 8,000..43,500 step 500
      commodity: rng.choice(COMMODITIES),
      pickupAt: new Date(now.getTime() + rng.randInt(12, 95) * 3_600_000),
      customerRateCents: customerRate,
      targetMarginBps: marginBps,
      maxCarrierPayCents: maxCarrierPay,
      floorCents: Math.round(maxCarrierPay * 0.8333),
    });
  }
  return loads;
}

/** Deterministic given (now, seed). One rng instance threaded through, no globals. */
export function generateDataset(now: Date, seed: number = DEFAULT_SEED, carrierCount: number = CARRIER_COUNT): Dataset {
  const rng = new Rng(seed);
  const carriers = generateCarriers(rng, carrierCount);
  const lanes = generateCarrierLanes(rng, carriers);
  const loads = generateLoads(rng, now);
  return { carriers, lanes, loads };
}

