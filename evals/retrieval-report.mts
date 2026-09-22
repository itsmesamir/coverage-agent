/**
 * Measure the first-stage candidate search against exhaustive search over the
 * whole population. Reports recall@50 and precision@5 per load. No LLM calls.
 */

import { createClient, createDb } from "../api/app/db/client.js";
import { carrierLanes, carriers } from "../api/app/db/schema.js";
import type { Equipment } from "../api/app/domain/equipment.js";
import { embedQuery } from "../api/app/retrieval/embed.js";
import { buildLoadQueryText } from "../api/app/retrieval/profile.js";
import { rerank, type RerankCandidate } from "../api/app/retrieval/rerank.js";
import { annSearch, type LoadQuery } from "../api/app/retrieval/search.js";
import { getMetro, laneMarketRateCents } from "../seed/geography.js";
import { precisionAtK, rankCorrelation, recallAtK } from "./metrics/retrieval.js";
import { and, eq } from "drizzle-orm";

const LANES: ReadonlyArray<[string, string, Equipment, number]> = [
  ["Chicago, IL", "Dallas, TX", "dry_van", 42_000],
  ["Dallas, TX", "Houston, TX", "dry_van", 38_000],
  ["Los Angeles, CA", "Phoenix, AZ", "reefer", 40_000],
  ["Atlanta, GA", "Charlotte, NC", "dry_van", 30_000],
  ["Newark, NJ", "Chicago, IL", "flatbed", 44_000],
  ["Denver, CO", "Salt Lake City, UT", "dry_van", 22_000],
];

const client = createClient();
const db = createDb(client);

/** Exhaustive: every carrier in the population, scored by the same reranker. */
async function oracle(query: LoadQuery): Promise<RerankCandidate[]> {
  const rows = await db
    .select({
      carrierId: carriers.carrierId,
      authorityActive: carriers.authorityActive,
      equipment: carriers.equipment,
      onTimeBps: carriers.onTimeBps,
    })
    .from(carriers);

  const lanes = await db
    .select({
      carrierId: carrierLanes.carrierId,
      loadsRun: carrierLanes.loadsRun,
      lastRateCents: carrierLanes.lastRateCents,
      lastRunDaysAgo: carrierLanes.lastRunDaysAgo,
    })
    .from(carrierLanes)
    .where(and(eq(carrierLanes.origin, query.origin), eq(carrierLanes.destination, query.destination)));

  const byCarrier = new Map(lanes.map((l) => [l.carrierId, l]));
  return rows.map((row) => {
    const lane = byCarrier.get(row.carrierId);
    return {
      carrierId: row.carrierId,
      authorityActive: row.authorityActive,
      equipment: row.equipment as Equipment[],
      onTimeBps: row.onTimeBps,
      laneLoadsRun: lane?.loadsRun,
      laneLastRateCents: lane?.lastRateCents,
      laneLastRunDaysAgo: lane?.lastRunDaysAgo,
    } satisfies RerankCandidate;
  });
}

console.log("lane                                    recall@50  precision@5  tau   pool");
console.log("-".repeat(78));

let recallSum = 0;
let precisionSum = 0;

for (const [origin, destination, equipment, weightLbs] of LANES) {
  const marketRateCents = laneMarketRateCents(getMetro(origin), getMetro(destination), equipment);
  const query: LoadQuery = { origin, destination, equipment, weightLbs, marketRateCents };
  const context = { requiredEquipment: equipment, weightLbs, marketRateCents };

  const all = await oracle(query);
  const idealRanked = rerank(all, context, all.length);
  // "Relevant" = the exhaustive top 10. Recall asks how many of those the
  // first stage put in front of the reranker at all.
  const relevant = idealRanked.slice(0, 10).map((r) => r.carrierId);

  const vector = await embedQuery(buildLoadQueryText(query));
  const retrieved = await annSearch(db, query, vector, 50);
  const ranked = rerank(retrieved, context, 5);

  const recall = recallAtK(retrieved.map((c) => c.carrierId), relevant);
  const precision = precisionAtK(
    ranked.map((r) => r.carrierId),
    idealRanked.map((r) => r.carrierId),
    5,
  );
  const tau = rankCorrelation(
    ranked.map((r) => r.carrierId),
    idealRanked.map((r) => r.carrierId),
  );

  recallSum += recall;
  precisionSum += precision;
  console.log(
    `${`${origin} -> ${destination}`.padEnd(38)}  ${recall.toFixed(2).padStart(7)}  ` +
    `${precision.toFixed(2).padStart(11)}  ${tau.toFixed(2).padStart(5)}  ${String(idealRanked.length).padStart(4)}`,
  );
}

console.log("-".repeat(78));
console.log(
  `mean${" ".repeat(34)}  ${(recallSum / LANES.length).toFixed(2).padStart(7)}  ` +
  `${(precisionSum / LANES.length).toFixed(2).padStart(11)}`,
);
await client.end();
