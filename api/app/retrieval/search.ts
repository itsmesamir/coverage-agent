/**
 * Two-stage retrieval: pgvector similarity for recall, then the pure reranker
 * for precision.
 *
 * Honest naming: at 200 carriers there is no HNSW/IVFFlat index, so `<=>` is a
 * sequential scan with an exact sort. This is exact KNN truncated to 50, not
 * approximate nearest neighbour. The two-stage shape is here because it is what
 * the architecture needs at 200,000 carriers, and the index is the one line
 * that changes -- but claiming ANN today would be claiming something the query
 * plan does not do. See docs/DECISIONS.md.
 *
 * Stage one filters only on authority, then takes the 50 nearest profiles.
 * Equipment compatibility is not filtered here even though it can also make a
 * carrier unbookable: a reefer on a dry van load is a legal substitute, not a
 * hard block, and that gradient (exact / substitute / blocked) is exactly what
 * the reranker's usableTrailer already computes. Duplicating it as a SQL
 * filter would only let us reject carriers earlier, at the cost of a second
 * definition of equipment compatibility to keep in sync with the first.
 *
 * The authority filter alone is still deliberately narrow: filtering harder
 * here would trade recall for precision, and recall lost in stage one can
 * never be recovered -- the reranker only ever sees what this stage returned.
 *
 * Lane history is attached after the vector search rather than joined into it,
 * because most candidates have never run the exact lane and an inner join would
 * silently drop them -- turning a ranking signal into a hard filter by accident.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Equipment } from "../domain/equipment.js";
import type { Database } from "../db/client.js";
import { carrierLanes, carriers } from "../db/schema.js";
import { embedQuery } from "./embed.js";
import { buildLoadQueryText } from "./profile.js";
import { rerank, type RankedCarrier, type RerankCandidate } from "./rerank.js";

export const ANN_LIMIT = 50;
export const RERANK_LIMIT = 5;

export interface LoadQuery {
  readonly origin: string;
  readonly destination: string;
  readonly equipment: Equipment;
  readonly weightLbs: number;
  readonly marketRateCents: number;
}

export interface RetrievalResult {
  readonly candidates: readonly RerankCandidate[];
  readonly ranked: readonly RankedCarrier[];
  readonly timings: { readonly embedMs: number; readonly annMs: number; readonly rerankMs: number };
}

/**
 * Stage one. Returns up to `limit` carriers nearest the load in embedding
 * space, with their history on this specific lane attached when it exists.
 */
export async function annSearch(
  db: Database,
  query: LoadQuery,
  queryVector: number[],
  limit = ANN_LIMIT,
): Promise<RerankCandidate[]> {
  const literal = `[${queryVector.join(",")}]`;

  const rows = await db
    .select({
      carrierId: carriers.carrierId,
      authorityActive: carriers.authorityActive,
      equipment: carriers.equipment,
      onTimeBps: carriers.onTimeBps,
      distance: sql<number>`${carriers.embedding} <=> ${literal}::vector`,
    })
    .from(carriers)
    // Authority is a hard filter in the policy engine, so ranking an inactive
    // carrier would waste a slot on something we could never book.
    .where(and(eq(carriers.authorityActive, true), sql`${carriers.embedding} is not null`))
    .orderBy(sql`${carriers.embedding} <=> ${literal}::vector`)
    .limit(limit);

  if (rows.length === 0) return [];

  const history = await db
    .select({
      carrierId: carrierLanes.carrierId,
      loadsRun: carrierLanes.loadsRun,
      lastRateCents: carrierLanes.lastRateCents,
      lastRunDaysAgo: carrierLanes.lastRunDaysAgo,
    })
    .from(carrierLanes)
    .where(
      and(
        inArray(
          carrierLanes.carrierId,
          rows.map((r) => r.carrierId),
        ),
        eq(carrierLanes.origin, query.origin),
        eq(carrierLanes.destination, query.destination),
      ),
    );

  const byCarrier = new Map(history.map((h) => [h.carrierId, h]));

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

/** The full pipeline: embed the load, search to 50, rerank to 5. */
export async function searchCarriers(
  db: Database,
  query: LoadQuery,
  annLimit = ANN_LIMIT,
  rerankLimit = RERANK_LIMIT,
): Promise<RetrievalResult> {
  const t0 = performance.now();
  const queryVector = await embedQuery(buildLoadQueryText(query));
  const t1 = performance.now();
  const candidates = await annSearch(db, query, queryVector, annLimit);
  const t2 = performance.now();
  const ranked = rerank(
    candidates,
    {
      requiredEquipment: query.equipment,
      weightLbs: query.weightLbs,
      marketRateCents: query.marketRateCents,
    },
    rerankLimit,
  );
  const t3 = performance.now();

  return {
    candidates,
    ranked,
    timings: { embedMs: t1 - t0, annMs: t2 - t1, rerankMs: t3 - t2 },
  };
}
