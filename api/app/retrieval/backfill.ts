/**
 * Build carrier profile text, embed it, and write both back.
 *
 * Idempotent: rerunning produces the same vectors, because the profile text is
 * a pure function of the carrier and its lanes and the model is fixed. Safe to
 * run after every reseed.
 */

import { eq } from "drizzle-orm";

import { createClient, createDb, type Database } from "../db/client.js";
import { carrierLanes, carriers } from "../db/schema.js";
import type { Equipment } from "../domain/equipment.js";
import { embedDocumentsBatched } from "./embed.js";
import { buildProfileText } from "./profile.js";

export async function backfillEmbeddings(db: Database): Promise<number> {
  const rows = await db
    .select({
      carrierId: carriers.carrierId,
      name: carriers.name,
      equipment: carriers.equipment,
      homeRegion: carriers.homeRegion,
      fleetSize: carriers.fleetSize,
      onTimeBps: carriers.onTimeBps,
    })
    .from(carriers);

  const lanes = await db
    .select({
      carrierId: carrierLanes.carrierId,
      origin: carrierLanes.origin,
      destination: carrierLanes.destination,
      loadsRun: carrierLanes.loadsRun,
    })
    .from(carrierLanes);

  const lanesByCarrier = new Map<string, { origin: string; destination: string; loadsRun: number }[]>();
  for (const lane of lanes) {
    const list = lanesByCarrier.get(lane.carrierId) ?? [];
    list.push(lane);
    lanesByCarrier.set(lane.carrierId, list);
  }

  const profiles = rows.map((row) =>
    buildProfileText(
      { ...row, equipment: row.equipment as Equipment[] },
      lanesByCarrier.get(row.carrierId) ?? [],
    ),
  );

  const vectors = await embedDocumentsBatched(profiles);

  for (const [i, row] of rows.entries()) {
    await db
      .update(carriers)
      .set({ profileText: profiles[i]!, embedding: vectors[i]! })
      .where(eq(carriers.carrierId, row.carrierId));
  }

  return rows.length;
}

async function main(): Promise<void> {
  const client = createClient();
  try {
    const started = performance.now();
    const count = await backfillEmbeddings(createDb(client));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`embedded ${count} carrier profiles in ${seconds}s`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
