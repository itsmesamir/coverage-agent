/**
 * The version column is not decoration: it must actually reject a stale
 * writer.
 *
 * The pure state machine (state/machine.ts) decides what the next state is.
 * This is the other half -- persisting it safely when two workers hold the
 * same negotiation. The CHECK-constraint test for an invalid state is not
 * repeated here: it is identical to "rejects an unknown negotiation state"
 * in db-schema.test.ts, which already exercises the same statement against
 * the same column.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, createDb } from "../../app/db/client.js";
import { carriers, loads, negotiations } from "../../app/db/schema.js";
import { apply, newNegotiationStatus, type Event, type NegotiationStatus } from "../../app/state/machine.js";
import type { NegotiationState } from "../../app/domain/negotiation.js";

const client = createClient();
const db = createDb(client);

let liveIds: { negotiationId: string; loadId: string; carrierId: string } | null = null;

async function freshNegotiation(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const loadId = `T-${suffix.slice(0, 6)}`;
  const carrierId = `TC-${suffix.slice(0, 6)}`;
  const negotiationId = randomUUID();

  await db.insert(loads).values({
    loadId,
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    weightLbs: 42_000,
    commodity: "general freight",
    pickupAt: new Date(),
    customerRateCents: 240_000,
    targetMarginBps: 1500,
    maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  });
  await db.insert(carriers).values({
    carrierId,
    name: "T",
    mcNumber: `MC-V${suffix}`,
    dotNumber: `DOT-V${suffix}`,
    authorityActive: true,
    equipment: ["dry_van"],
    fleetSize: 2,
    onTimeBps: 9000,
    homeRegion: "midwest",
  });
  await db.insert(negotiations).values({
    id: negotiationId,
    loadId,
    carrierId,
    state: "NEGOTIATING",
    version: 1,
  });

  liveIds = { negotiationId, loadId, carrierId };
  return negotiationId;
}

afterEach(async () => {
  if (!liveIds) return;
  await db.delete(negotiations).where(eq(negotiations.id, liveIds.negotiationId));
  await db.delete(carriers).where(eq(carriers.carrierId, liveIds.carrierId));
  await db.delete(loads).where(eq(loads.loadId, liveIds.loadId));
  liveIds = null;
});

/**
 * Conditional write. Returns rows affected: 0 means we lost the race.
 *
 * `held` is the status this writer read earlier and still believes. It is
 * deliberately NOT re-read from the database: re-reading would paper over the
 * race, because the loser would see the winner's state and never attempt the
 * write that must be rejected.
 */
async function write(negotiationId: string, held: NegotiationStatus, event: Event): Promise<number> {
  const next = apply(held, event);
  const result = await db
    .update(negotiations)
    .set({ state: next.state, version: next.version })
    .where(and(eq(negotiations.id, negotiationId), eq(negotiations.version, held.version)));
  return result.count;
}

describe("optimistic concurrency on negotiations.version", () => {
  it("two writers holding the same version: only one wins", async () => {
    // Both read version 1. Both compute a next state. Only one write lands.
    const negotiationId = await freshNegotiation();
    const held = newNegotiationStatus("NEGOTIATING", 1);

    const first = await write(negotiationId, held, "terms_agreed");
    const second = await write(negotiationId, held, "counter_sent");

    expect(first).toBe(1); // the first writer should win
    expect(second).toBe(0); // the second writer held stale state and must be rejected

    const [row] = await db.select().from(negotiations).where(eq(negotiations.id, negotiationId));
    expect(row?.state).toBe("AGREED");
    expect(row?.version).toBe(2);
  });

  it("a writer that re-reads succeeds: lose, re-read, recompute, retry", async () => {
    const negotiationId = await freshNegotiation();
    const stale = newNegotiationStatus("NEGOTIATING", 1);

    expect(await write(negotiationId, stale, "terms_agreed")).toBe(1);

    // A second worker still holding version 1 tries to move it. Rejected.
    expect(await write(negotiationId, stale, "escalated")).toBe(0);

    // Recovery: re-read, recompute from what is actually true, retry.
    const [row] = await db.select().from(negotiations).where(eq(negotiations.id, negotiationId));
    // The database column is a plain varchar; ck_negotiations_state is what
    // actually guarantees this value is a real NegotiationState. The cast
    // below trusts that constraint, the same boundary the policy tests trust
    // when casting an accessorial code read back from the database.
    const fresh = newNegotiationStatus(row!.state as NegotiationState, row!.version);
    expect(await write(negotiationId, fresh, "booking_started")).toBe(1);

    const [after] = await db.select().from(negotiations).where(eq(negotiations.id, negotiationId));
    expect(after?.state).toBe("BOOKING");
    expect(after?.version).toBe(3);
  });
});
