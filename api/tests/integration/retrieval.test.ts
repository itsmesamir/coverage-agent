/**
 * The retrieval pipeline against the real seeded database.
 *
 * Loads the embedding model once for the file, so the first run pays the model
 * download and the rest are milliseconds.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, createDb, type Database } from "../../app/db/client.js";
import { embedQuery } from "../../app/retrieval/embed.js";
import { buildLoadQueryText } from "../../app/retrieval/profile.js";
import { annSearch, searchCarriers, type LoadQuery } from "../../app/retrieval/search.js";
import { getMetro, laneMarketRateCents } from "../../../seed/geography.js";

const REFERENCE: LoadQuery = {
  origin: "Chicago, IL",
  destination: "Dallas, TX",
  equipment: "dry_van",
  weightLbs: 42_000,
  marketRateCents: laneMarketRateCents(getMetro("Chicago, IL"), getMetro("Dallas, TX"), "dry_van"),
};

let client: ReturnType<typeof createClient>;
let db: Database;

beforeAll(async () => {
  client = createClient();
  db = createDb(client);
});

afterAll(async () => {
  await client.end();
});

describe("retrieval on the reference load", () => {
  it("returns the requested number of candidates and exactly five ranked", async () => {
    const result = await searchCarriers(db, REFERENCE);
    expect(result.candidates).toHaveLength(50);
    expect(result.ranked).toHaveLength(5);
  }, 120_000);

  it("never ranks a carrier without active authority", async () => {
    const result = await searchCarriers(db, REFERENCE);
    for (const candidate of result.candidates) {
      expect(candidate.authorityActive).toBe(true);
    }
  }, 60_000);

  it("only ranks carriers that own a trailer able to take the load", async () => {
    const result = await searchCarriers(db, REFERENCE);
    for (const ranked of result.ranked) {
      const candidate = result.candidates.find((c) => c.carrierId === ranked.carrierId);
      expect(candidate?.equipment).toContain(ranked.trailer);
    }
  }, 60_000);

  it("is deterministic across runs", async () => {
    const a = await searchCarriers(db, REFERENCE);
    const b = await searchCarriers(db, REFERENCE);
    expect(a.ranked.map((r) => r.carrierId)).toEqual(b.ranked.map((r) => r.carrierId));
  }, 60_000);

  it("surfaces carriers with history on the exact lane", async () => {
    const result = await searchCarriers(db, REFERENCE);
    const withHistory = result.candidates.filter((c) => c.laneLoadsRun !== undefined);
    expect(withHistory.length).toBeGreaterThan(5);
  }, 60_000);

  it("attaches lane history without dropping carriers that lack it", async () => {
    // An inner join here would silently turn a ranking signal into a hard
    // filter. Most candidates have never run the exact lane.
    const vector = await embedQuery(buildLoadQueryText(REFERENCE));
    const candidates = await annSearch(db, REFERENCE, vector, 50);
    expect(candidates.some((c) => c.laneLoadsRun === undefined)).toBe(true);
    expect(candidates.some((c) => c.laneLoadsRun !== undefined)).toBe(true);
  }, 60_000);

  it("ranks a heavy load away from carriers that only own reefers", async () => {
    // A reefer may haul dry freight but caps at 43,500 lbs.
    const heavy = { ...REFERENCE, weightLbs: 44_500 };
    const result = await searchCarriers(db, heavy);
    for (const ranked of result.ranked) {
      expect(ranked.trailer).not.toBe("reefer");
    }
  }, 60_000);

  it("reports timings for each stage", async () => {
    const { timings } = await searchCarriers(db, REFERENCE);
    expect(timings.embedMs).toBeGreaterThan(0);
    expect(timings.annMs).toBeGreaterThan(0);
    // The reranker is pure arithmetic over 50 rows: it should be trivial next
    // to the model call and the database round trip.
    expect(timings.rerankMs).toBeLessThan(timings.embedMs);
  }, 60_000);
});
