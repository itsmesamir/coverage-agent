/**
 * Corridor structure for synthetic lane generation.
 *
 * The geography itself -- metros, distances, market rates -- moved to
 * `api/app/domain/geography.ts` because the agent needs it at negotiation time
 * and runtime code must not import from seed/. Re-exported here so the
 * generators keep reading naturally.
 */

export * from "../api/app/domain/geography.js";

export interface Corridor {
  readonly origin: string;
  readonly destination: string;
  readonly weight: number;
}

/**
 * Freight volume concentrates on a relatively small number of named
 * corridors. These are real high-volume US truckload lanes; the weights are
 * invented. Chicago -> Dallas appears because it is genuinely one of the
 * busiest dry van lanes in the country, which is presumably why it is the
 * reference load -- not because the reference load needs propping up.
 */
export const MAJOR_CORRIDORS: readonly Corridor[] = [
  { origin: "Chicago, IL", destination: "Dallas, TX", weight: 10 },
  { origin: "Dallas, TX", destination: "Chicago, IL", weight: 8 },
  { origin: "Los Angeles, CA", destination: "Phoenix, AZ", weight: 9 },
  { origin: "Phoenix, AZ", destination: "Los Angeles, CA", weight: 7 },
  { origin: "Chicago, IL", destination: "Atlanta, GA", weight: 8 },
  { origin: "Atlanta, GA", destination: "Chicago, IL", weight: 7 },
  { origin: "Los Angeles, CA", destination: "Dallas, TX", weight: 7 },
  { origin: "Dallas, TX", destination: "Los Angeles, CA", weight: 6 },
  { origin: "Chicago, IL", destination: "Newark, NJ", weight: 7 },
  { origin: "Newark, NJ", destination: "Chicago, IL", weight: 6 },
  { origin: "Houston, TX", destination: "Dallas, TX", weight: 8 },
  { origin: "Dallas, TX", destination: "Houston, TX", weight: 8 },
  { origin: "Atlanta, GA", destination: "Charlotte, NC", weight: 6 },
  { origin: "Memphis, TN", destination: "Dallas, TX", weight: 5 },
  { origin: "Chicago, IL", destination: "Detroit, MI", weight: 6 },
  { origin: "Chicago, IL", destination: "Minneapolis, MN", weight: 5 },
  { origin: "Los Angeles, CA", destination: "Oakland, CA", weight: 5 },
  { origin: "Atlanta, GA", destination: "Jacksonville, FL", weight: 5 },
  { origin: "Seattle, WA", destination: "Portland, OR", weight: 4 },
  { origin: "Denver, CO", destination: "Salt Lake City, UT", weight: 4 },
];
