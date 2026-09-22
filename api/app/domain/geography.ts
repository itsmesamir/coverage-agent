/**
 * US freight geography and the deterministic lane market rate.
 *
 * Clearly synthetic. Real metros and coordinates, invented rates.
 *
 * Lives in domain/ rather than seed/ because two very different callers need
 * it: the generator samples lanes from it, and `get_market_rate` answers the
 * agent with it at negotiation time. Runtime code importing from seed/ would
 * make synthetic-data generation a production dependency.
 *
 * Money is integer cents everywhere (invariant 8). Rates per mile are held in
 * cents-per-mile as integers so no float ever touches a money value.
 *
 * Pure: no imports outside domain/. Enforced by .dependency-cruiser.cjs.
 */

import type { Equipment } from "./equipment.js";

export interface Metro {
  readonly city: string;
  readonly state: string;
  /** Precomputed rather than a getter, matching this codebase's "plain data
   * plus functions" style (see state/machine.ts). */
  readonly name: string;
  readonly region: string;
  readonly lat: number;
  readonly lon: number;
  /**
   * Relative freight volume. Truck traffic concentrates on a handful of major
   * corridors rather than spreading evenly over the map, so lane endpoints
   * are sampled weighted by this. Invented, ordinally plausible.
   */
  readonly gravity: number;
}

function metro(
  city: string,
  state: string,
  region: string,
  lat: number,
  lon: number,
  gravity: number,
): Metro {
  return { city, state, name: `${city}, ${state}`, region, lat, lon, gravity };
}

export const METROS: readonly Metro[] = [
  metro("Chicago", "IL", "midwest", 41.8781, -87.6298, 100),
  metro("Indianapolis", "IN", "midwest", 39.7684, -86.1581, 46),
  metro("Columbus", "OH", "midwest", 39.9612, -82.9988, 38),
  metro("Detroit", "MI", "midwest", 42.3314, -83.0458, 40),
  metro("Minneapolis", "MN", "midwest", 44.9778, -93.265, 34),
  metro("Kansas City", "MO", "midwest", 39.0997, -94.5786, 36),
  metro("St. Louis", "MO", "midwest", 38.627, -90.1994, 34),
  metro("Dallas", "TX", "southwest", 32.7767, -96.797, 92),
  metro("Houston", "TX", "southwest", 29.7604, -95.3698, 74),
  metro("San Antonio", "TX", "southwest", 29.4241, -98.4936, 30),
  metro("Phoenix", "AZ", "southwest", 33.4484, -112.074, 44),
  metro("Albuquerque", "NM", "southwest", 35.0844, -106.6504, 14),
  metro("Atlanta", "GA", "southeast", 33.749, -84.388, 86),
  metro("Charlotte", "NC", "southeast", 35.2271, -80.8431, 40),
  metro("Nashville", "TN", "southeast", 36.1627, -86.7816, 42),
  metro("Jacksonville", "FL", "southeast", 30.3322, -81.6557, 32),
  metro("Memphis", "TN", "southeast", 35.1495, -90.049, 54),
  metro("Newark", "NJ", "northeast", 40.7357, -74.1724, 70),
  metro("Philadelphia", "PA", "northeast", 39.9526, -75.1652, 46),
  metro("Boston", "MA", "northeast", 42.3601, -71.0589, 34),
  metro("Baltimore", "MD", "northeast", 39.2904, -76.6122, 32),
  metro("Los Angeles", "CA", "west", 34.0522, -118.2437, 96),
  metro("Oakland", "CA", "west", 37.8044, -122.2712, 44),
  metro("Seattle", "WA", "west", 47.6062, -122.3321, 38),
  metro("Portland", "OR", "west", 45.5152, -122.6784, 26),
  metro("Salt Lake City", "UT", "west", 40.7608, -111.891, 26),
  metro("Denver", "CO", "west", 39.7392, -104.9903, 34),
];

export const BY_NAME: ReadonlyMap<string, Metro> = new Map(METROS.map((m) => [m.name, m]));

export function getMetro(name: string): Metro {
  const m = BY_NAME.get(name);
  if (!m) throw new RangeError(`unknown metro: ${name}`);
  return m;
}

/** Trucks follow roads, not great circles. 1.17 is a conventional circuity factor. */
const ROAD_CIRCUITY = 1.17;

/**
 * Invented, not market data. Reefers and flatbeds pay more per mile than dry
 * van: reefers burn fuel running the unit, flatbeds require tarping and
 * securement.
 */
export const RATE_PER_MILE_CENTS = {
  dry_van: 211,
  reefer: 252,
  flatbed: 243,
  specialized: 320,
} as const satisfies Record<Equipment, number>;

/** Short hauls do not scale linearly -- a 90-mile run still costs a driver a day. */
const MINIMUM_LINEHAUL_CENTS = 35_000;

export function haversineMiles(a: Metro, b: Metro): number {
  const rad = Math.PI / 180;
  const [lat1, lon1, lat2, lon2] = [a.lat * rad, a.lon * rad, b.lat * rad, b.lon * rad];
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(h)) * 3958.8;
}

export function roadMiles(a: Metro, b: Metro): number {
  return Math.round(haversineMiles(a, b) * ROAD_CIRCUITY);
}

/**
 * Deterministic mid-market linehaul for a lane. No randomness, no clock.
 *
 * This is the centre that per-carrier historical rates are sampled around.
 */
export function laneMarketRateCents(origin: Metro, destination: Metro, equipment: Equipment): number {
  const miles = roadMiles(origin, destination);
  return Math.max(MINIMUM_LINEHAUL_CENTS, miles * RATE_PER_MILE_CENTS[equipment]);
}

