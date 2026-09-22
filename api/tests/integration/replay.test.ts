/**
 * Replay reads stored traces and scores them without re-running anything.
 *
 * The important tests here plant a trace that IS in violation and require
 * replay to find it. A replay that only ever reports zero is indistinguishable
 * from one that cannot see.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, createDb, type Database } from "../../app/db/client.js";
import { bookings, carriers, loads, messages, negotiations, toolCalls } from "../../app/db/schema.js";
import { acceptedDecisions, loadTrace, scoreTrace } from "../../../evals/replay.js";

let client: ReturnType<typeof createClient>;
let db: Database;
let loadId: string;
let carrierId: string;
let negotiationId: string;

beforeAll(async () => {
  client = createClient();
  db = createDb(client);
  const suffix = randomUUID().slice(0, 6);
  loadId = `RP-${suffix}`;
  carrierId = `RC-${suffix}`;

  await db.insert(loads).values({
    loadId, origin: "Chicago, IL", destination: "Dallas, TX", equipment: "dry_van",
    weightLbs: 42_000, commodity: "general freight", pickupAt: new Date("2026-09-17T08:00:00Z"),
    customerRateCents: 240_000, targetMarginBps: 1500, maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  });
  await db.insert(carriers).values({
    carrierId, name: "Replay Carrier", mcNumber: `MC-P${suffix}`, dotNumber: `DOT-P${suffix}`,
    authorityActive: true, equipment: ["dry_van"], fleetSize: 3, onTimeBps: 9200,
    homeRegion: "midwest",
  });
});

afterEach(async () => {
  await db.delete(bookings).where(eq(bookings.loadId, loadId));
  await db.delete(negotiations).where(eq(negotiations.loadId, loadId));
});

afterAll(async () => {
  await db.delete(bookings).where(eq(bookings.loadId, loadId));
  await db.delete(negotiations).where(eq(negotiations.loadId, loadId));
  await db.delete(carriers).where(eq(carriers.carrierId, carrierId));
  await db.delete(loads).where(eq(loads.loadId, loadId));
  await client.end();
});

/** Write a trace by hand, so a specific shape can be planted. */
async function plant(opts: {
  state: string;
  decisions: { tool: string; linehaul: number; total: number; counter?: boolean; codes?: string[] }[];
  booking?: { linehaul: number; total: number };
}): Promise<string> {
  const id = randomUUID();
  negotiationId = id;
  await db.insert(negotiations).values({ id, loadId, carrierId, state: opts.state });

  for (const d of opts.decisions) {
    await db.insert(toolCalls).values({
      id: randomUUID(),
      negotiationId: id,
      requestId: randomUUID(),
      toolName: d.tool,
      idempotencyKey: randomUUID().slice(0, 12),
      arguments: { linehaul_cents: d.linehaul },
      result: {
        ok: true,
        data: {
          linehaul_cents: d.linehaul,
          total_cents: d.total,
          counts_as_counter: d.counter === true,
          accessorials: (d.codes ?? []).map((code) => ({ code, amount_cents: 0 })),
        },
      },
      policyResult: "accepted",
      rejectionCode: null,
      rejectionReason: null,
      latencyMs: 1,
    });
  }

  if (opts.booking) {
    await db.insert(bookings).values({
      id: randomUUID(), negotiationId: id, loadId, carrierId,
      linehaulCents: opts.booking.linehaul, accessorials: [],
      totalConsiderationCents: opts.booking.total,
      idempotencyKey: `rp-${randomUUID().slice(0, 12)}`,
    });
  }
  return id;
}

describe("loading a trace", () => {
  it("reconstructs the negotiation from the database alone", async () => {
    const id = await plant({
      state: "BOOKED",
      decisions: [{ tool: "propose_rate", linehaul: 195_000, total: 195_000 }],
      booking: { linehaul: 195_000, total: 195_000 },
    });

    const trace = await loadTrace(db, id);
    expect(trace?.finalState).toBe("BOOKED");
    expect(trace?.load.maxCarrierPayCents).toBe(204_000);
    expect(trace?.toolCalls).toHaveLength(1);
    expect(trace?.bookings).toHaveLength(1);
  });

  it("returns undefined for a negotiation that does not exist", async () => {
    expect(await loadTrace(db, randomUUID())).toBeUndefined();
  });

  it("counts only accepted mutating calls as decisions", async () => {
    const id = await plant({
      state: "NEGOTIATING",
      decisions: [{ tool: "propose_rate", linehaul: 195_000, total: 195_000 }],
    });
    // A read-only call and a rejected one, neither of which changed anything.
    await db.insert(toolCalls).values({
      id: randomUUID(), negotiationId: id, requestId: randomUUID(),
      toolName: "get_market_rate", idempotencyKey: null, arguments: {},
      result: { ok: true, data: { market_rate_cents: 198_551 } },
      policyResult: "not_applicable", rejectionCode: null, rejectionReason: null, latencyMs: 1,
    });
    await db.insert(toolCalls).values({
      id: randomUUID(), negotiationId: id, requestId: randomUUID(),
      toolName: "propose_rate", idempotencyKey: "r1", arguments: { linehaul_cents: 500_000 },
      result: { ok: false, code: "above_max_carrier_pay", explanation: "no" },
      policyResult: "rejected", rejectionCode: "above_max_carrier_pay",
      rejectionReason: "no", latencyMs: 1,
    });

    const trace = await loadTrace(db, id);
    expect(trace?.toolCalls).toHaveLength(3);
    // A rejected call changed nothing; counting it would make the engine doing
    // its job look like the engine failing.
    expect(acceptedDecisions(trace!)).toHaveLength(1);
  });
});

describe("scoring a stored trace", () => {
  it("reports a clean negotiation as clean", async () => {
    const id = await plant({
      state: "BOOKED",
      decisions: [
        { tool: "propose_rate", linehaul: 180_000, total: 180_000 },
        { tool: "accept_counter", linehaul: 195_000, total: 195_000, counter: true },
      ],
      booking: { linehaul: 195_000, total: 195_000 },
    });
    const score = scoreTrace((await loadTrace(db, id))!);
    expect(score.violations).toEqual([]);
    expect(score.decisionsChecked).toBe(2);
  });

  it("catches a booking above the ceiling in a stored trace", async () => {
    const id = await plant({
      state: "BOOKED",
      decisions: [{ tool: "book_carrier", linehaul: 250_000, total: 250_000 }],
      booking: { linehaul: 250_000, total: 250_000 },
    });
    const score = scoreTrace((await loadTrace(db, id))!);
    const kinds = score.violations.map((v) => v.kind);
    expect(kinds).toContain("booking_above_ceiling");
    expect(kinds).toContain("offer_above_ceiling");
  });

  it("catches a fourth counter in a stored trace", async () => {
    const id = await plant({
      state: "NEGOTIATING",
      decisions: [175_000, 180_000, 185_000, 190_000].map((v) => ({
        tool: "propose_rate", linehaul: v, total: v, counter: true,
      })),
    });
    const score = scoreTrace((await loadTrace(db, id))!);
    expect(score.violations.map((v) => v.kind)).toContain("counter_limit_exceeded");
  });

  it("catches a booking on a negotiation that never agreed terms", async () => {
    const id = await plant({
      state: "NEGOTIATING",
      decisions: [{ tool: "propose_rate", linehaul: 195_000, total: 195_000 }],
      booking: { linehaul: 195_000, total: 195_000 },
    });
    const score = scoreTrace((await loadTrace(db, id))!);
    expect(score.violations.map((v) => v.kind)).toContain("booked_without_agreement");
  });

  it("scores the same trace identically every time", async () => {
    const id = await plant({
      state: "BOOKED",
      decisions: [{ tool: "propose_rate", linehaul: 195_000, total: 195_000 }],
      booking: { linehaul: 195_000, total: 195_000 },
    });
    const trace = (await loadTrace(db, id))!;
    expect(scoreTrace(trace)).toEqual(scoreTrace(trace));
  });
});
