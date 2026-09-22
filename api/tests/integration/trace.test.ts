/**
 * Invariant 5: a trace must be reconstructable from the database alone.
 *
 * The test writes through DbTracer and then reads back with plain queries, no
 * in-memory state, because that is exactly what `eval-replay` will do.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, createDb, type Database } from "../../app/db/client.js";
import { carriers, loads, negotiations, toolCalls } from "../../app/db/schema.js";
import { DbTracer, InMemoryTracer, MultiTracer, newTraceId } from "../../app/obs/trace.js";
import { executeTool, type ToolContext } from "../../app/agent/tools.js";

let client: ReturnType<typeof createClient>;
let db: Database;
let negotiationId: string;
let loadId: string;
let carrierId: string;

beforeAll(async () => {
  client = createClient();
  db = createDb(client);
  const suffix = randomUUID().slice(0, 6);
  loadId = `R-${suffix}`;
  carrierId = `RC-${suffix}`;
  negotiationId = randomUUID();

  await db.insert(loads).values({
    loadId, origin: "Chicago, IL", destination: "Dallas, TX", equipment: "dry_van",
    weightLbs: 42_000, commodity: "general freight", pickupAt: new Date("2026-09-17T08:00:00Z"),
    customerRateCents: 240_000, targetMarginBps: 1500, maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  });
  await db.insert(carriers).values({
    carrierId, name: "Trace Test Carrier", mcNumber: `MC-R${suffix}`, dotNumber: `DOT-R${suffix}`,
    authorityActive: true, equipment: ["dry_van"], fleetSize: 3, onTimeBps: 9200,
    homeRegion: "midwest",
  });
  await db.insert(negotiations).values({
    id: negotiationId, loadId, carrierId, state: "NEGOTIATING",
  });
});

afterAll(async () => {
  await db.delete(negotiations).where(eq(negotiations.id, negotiationId));
  await db.delete(carriers).where(eq(carriers.carrierId, carrierId));
  await db.delete(loads).where(eq(loads.loadId, loadId));
  await client.end();
});

describe("a negotiation is reconstructable from the database alone", () => {
  it("replays a sequence of accepted and rejected calls in order", async () => {
    const requestId = randomUUID();
    const ctx: ToolContext = {
      db,
      tracer: new DbTracer(db),
      requestId,
      negotiationId,
      now: new Date("2026-09-16T12:00:00Z"),
    };

    await executeTool("get_market_rate",
      { origin: "Chicago, IL", destination: "Dallas, TX", equipment: "dry_van" }, ctx);
    await executeTool("propose_rate",
      { linehaul_cents: 210_000, idempotency_key: "t-1", reasoning: "opening high" }, ctx);
    await executeTool("propose_rate",
      { linehaul_cents: 195_000, idempotency_key: "t-2", reasoning: "inside band" }, ctx);

    // Nothing in memory from here on: this is what eval replay sees.
    const rows = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.negotiationId, negotiationId))
      .orderBy(toolCalls.createdAt);

    expect(rows.map((r) => r.toolName)).toEqual([
      "get_market_rate", "propose_rate", "propose_rate",
    ]);
    expect(rows.map((r) => r.policyResult)).toEqual(["not_applicable", "rejected", "accepted"]);
    expect(rows[1]?.rejectionCode).toBe("above_max_carrier_pay");
    expect(rows[1]?.rejectionReason).toContain("2,040.00");
    expect(rows[2]?.idempotencyKey).toBe("t-2");

    // Raw arguments survive the round trip, which is what makes re-scoring free.
    expect(rows[2]?.arguments).toEqual({
      linehaul_cents: 195_000, idempotency_key: "t-2", reasoning: "inside band",
    });
    for (const row of rows) {
      expect(row.requestId).toBe(requestId);
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns the id of the trace row it just wrote, on success", async () => {
    // This is the audit link behind invariant 2: render.ts and the loop use
    // this id as messages.rendered_from_tool_call_id, so an outbound price
    // traces to the exact tool_calls row that approved it, not just to "some
    // call in this negotiation around that time".
    const ctx: ToolContext = {
      db, tracer: new DbTracer(db), requestId: randomUUID(), negotiationId,
      now: new Date("2026-09-16T12:00:00Z"),
    };
    const outcome = await executeTool(
      "propose_rate",
      { linehaul_cents: 190_000, idempotency_key: "t-3", reasoning: "link check" },
      ctx,
    );
    if (!outcome.ok) throw new Error("expected approval");

    const [row] = await db.select().from(toolCalls).where(eq(toolCalls.id, outcome.toolCallId));
    expect(row?.idempotencyKey).toBe("t-3");
    expect(row?.negotiationId).toBe(negotiationId);
  });

  it("records the rejected attempt, not only the successful one", async () => {
    // Zero policy violations is a claim about what was ATTEMPTED and refused.
    // A trace that kept only successes could not support it.
    const rows = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.negotiationId, negotiationId));
    expect(rows.some((r) => r.policyResult === "rejected")).toBe(true);
  });
});

describe("MultiTracer", () => {
  it("fans out to every tracer", async () => {
    const a = new InMemoryTracer();
    const b = new InMemoryTracer();
    const multi = new MultiTracer([a, b]);
    await multi.recordToolCall({
      id: newTraceId(), requestId: "r", negotiationId: null, toolName: "get_market_rate",
      idempotencyKey: null, arguments: {}, result: null, policyResult: "not_applicable",
      rejectionCode: null, rejectionReason: null, latencyMs: 1,
    });
    expect(a.toolCalls).toHaveLength(1);
    expect(b.toolCalls).toHaveLength(1);
  });
});
