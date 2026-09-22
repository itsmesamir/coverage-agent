/**
 * Write generated records into Postgres.
 *
 * Separate from the generators on purpose: the generators stay pure and
 * unit-testable with no database, and this module is the only part that
 * needs one.
 *
 * Refuses to run if any negotiation exists. Reseeding drops carriers and
 * loads, and traces reference them -- silently destroying trace data would
 * take the replay corpus with it.
 */

import { sql } from "drizzle-orm";
import { createClient, createDb } from "../api/app/db/client.js";
import {
  carrierLanes,
  carriers,
  loads,
  negotiations,
} from "../api/app/db/schema.js";
import { DEFAULT_SEED, generateDataset } from "./generators.js";
import type { Dataset } from "./records.js";

export class SeedRefused extends Error {}

export async function loadDataset(
  db: ReturnType<typeof createDb>,
  dataset: Dataset,
): Promise<{ carriers: number; lanes: number; loads: number }> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(negotiations);
  const existing = row?.count ?? 0;
  if (existing > 0) {
    throw new SeedRefused(
      `${existing} negotiation(s) exist. Reseeding would orphan or delete trace ` +
        "data. Drop the database deliberately if that is what you want.",
    );
  }

  await db.delete(carrierLanes);
  await db.delete(carriers);
  await db.delete(loads);

  if (dataset.carriers.length > 0) {
    await db.insert(carriers).values(
      dataset.carriers.map((c) => ({
        carrierId: c.carrierId,
        name: c.name,
        mcNumber: c.mcNumber,
        dotNumber: c.dotNumber,
        authorityActive: c.authorityActive,
        equipment: [...c.equipment],
        fleetSize: c.fleetSize,
        onTimeBps: c.onTimeBps,
        homeRegion: c.homeRegion,
      })),
    );
  }

  if (dataset.loads.length > 0) {
    await db.insert(loads).values(
      dataset.loads.map((x) => ({
        loadId: x.loadId,
        origin: x.origin,
        destination: x.destination,
        equipment: x.equipment,
        weightLbs: x.weightLbs,
        commodity: x.commodity,
        pickupAt: x.pickupAt,
        customerRateCents: x.customerRateCents,
        targetMarginBps: x.targetMarginBps,
        maxCarrierPayCents: x.maxCarrierPayCents,
        floorCents: x.floorCents,
      })),
    );
  }

  // Carriers must exist before their lanes reference them -- true here since
  // both inserts run sequentially against the same connection, awaited in order.
  if (dataset.lanes.length > 0) {
    await db.insert(carrierLanes).values(
      dataset.lanes.map((lane) => ({
        carrierId: lane.carrierId,
        origin: lane.origin,
        destination: lane.destination,
        equipment: lane.equipment,
        loadsRun: lane.loadsRun,
        lastRateCents: lane.lastRateCents,
        lastRunDaysAgo: lane.lastRunDaysAgo,
      })),
    );
  }

  return {
    carriers: dataset.carriers.length,
    lanes: dataset.lanes.length,
    loads: dataset.loads.length,
  };
}

async function main(): Promise<void> {
  const client = createClient();
  try {
    const db = createDb(client);
    // `now` is injected here, at the edge, so everything inside stays pure.
    const dataset = generateDataset(new Date(), DEFAULT_SEED);
    const counts = await loadDataset(db, dataset);
    console.log(
      `seeded  carriers=${counts.carriers}  lanes=${counts.lanes}  ` +
        `loads=${counts.loads}  (seed=${DEFAULT_SEED})`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
