/**
 * The tool layer against the real database.
 *
 * Every assertion here is about the boundary: what the model may ask for, what
 * comes back, and what is written to the trace whether the call succeeded or not.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createClient, createDb, type Database } from "../../app/db/client.js";
import { carriers, loads, negotiations } from "../../app/db/schema.js";
import { InMemoryTracer } from "../../app/obs/trace.js";
import {
  MUTATING_TOOLS,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  executeTool,
  type ToolContext,
} from "../../app/agent/tools.js";

let client: ReturnType<typeof createClient>;
let db: Database;
let negotiationId: string;
let loadId: string;
let carrierId: string;

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    tracer: new InMemoryTracer(),
    requestId: randomUUID(),
    negotiationId,
    now: new Date("2026-09-16T12:00:00Z"),
    ...over,
  };
}

beforeAll(async () => {
  client = createClient();
  db = createDb(client);

  const suffix = randomUUID().slice(0, 6);
  loadId = `T-${suffix}`;
  carrierId = `TC-${suffix}`;
  negotiationId = randomUUID();

  await db.insert(loads).values({
    loadId,
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    weightLbs: 42_000,
    commodity: "general freight",
    pickupAt: new Date("2026-09-17T08:00:00Z"),
    customerRateCents: 240_000,
    targetMarginBps: 1500,
    maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  });
  await db.insert(carriers).values({
    carrierId,
    name: "Tool Test Carrier",
    mcNumber: `MC-T${suffix}`,
    dotNumber: `DOT-T${suffix}`,
    authorityActive: true,
    equipment: ["dry_van"],
    fleetSize: 4,
    onTimeBps: 9300,
    homeRegion: "midwest",
  });
  await db.insert(negotiations).values({
    id: negotiationId,
    loadId,
    carrierId,
    state: "NEGOTIATING",
  });
});

afterEach(async () => {
  await db.update(negotiations).set({ counterCount: 0, lastOfferTotalCents: null })
    .where(eq(negotiations.id, negotiationId));
});

afterAll(async () => {
  await db.delete(negotiations).where(eq(negotiations.id, negotiationId));
  await db.delete(carriers).where(eq(carriers.carrierId, carrierId));
  await db.delete(loads).where(eq(loads.loadId, loadId));
  await client.end();
});

describe("the tool surface", () => {
  it("is exactly seven tools", () => {
    expect(TOOL_NAMES).toHaveLength(7);
  });

  it("has no free-text send tool", () => {
    const names = TOOL_NAMES.join(" ");
    expect(names).not.toMatch(/send|message|email|reply|write/);
  });

  it("gives every tool a schema", () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("requires an idempotency key on every mutating tool", () => {
    for (const name of MUTATING_TOOLS) {
      const parsed = TOOL_SCHEMAS[name].safeParse({ linehaul_cents: 195_000, reasoning: "x" });
      expect(parsed.success, `${name} accepted a call with no idempotency key`).toBe(false);
    }
  });
});

describe("argument validation", () => {
  it("rejects a string where a number belongs, as a result not an exception", async () => {
    const outcome = await executeTool(
      "propose_rate",
      { linehaul_cents: "1950", idempotency_key: "k1", reasoning: "test" },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("invalid_arguments");
  });

  it("rejects a float amount, because money is integer cents", async () => {
    const outcome = await executeTool(
      "propose_rate",
      { linehaul_cents: 1950.5, idempotency_key: "k2", reasoning: "test" },
      context(),
    );
    expect(outcome.ok).toBe(false);
  });

  it("rejects an accessorial code outside the approved list", async () => {
    const outcome = await executeTool(
      "propose_rate",
      {
        linehaul_cents: 180_000,
        accessorials: [{ code: "helicopter_transfer", amount_cents: 5_000 }],
        idempotency_key: "k3",
        reasoning: "test",
      },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("invalid_arguments");
  });
});

describe("read-only tools", () => {
  it("get_market_rate answers from the deterministic rate table", async () => {
    const outcome = await executeTool(
      "get_market_rate",
      { origin: "Chicago, IL", destination: "Dallas, TX", equipment: "dry_van" },
      context(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect((outcome.data as { market_rate_cents: number }).market_rate_cents).toBe(198_551);
    }
  });

  it("get_market_rate refuses an unknown lane rather than inventing a number", async () => {
    const outcome = await executeTool(
      "get_market_rate",
      { origin: "Atlantis, XX", destination: "Dallas, TX", equipment: "dry_van" },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unknown_lane");
  });

  it("search_carriers returns ranked carriers", async () => {
    const outcome = await executeTool(
      "search_carriers",
      {
        origin: "Chicago, IL",
        destination: "Dallas, TX",
        equipment: "dry_van",
        weight_lbs: 42_000,
        limit: 5,
      },
      context(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const data = outcome.data as { carriers: unknown[]; considered: number };
      expect(data.carriers).toHaveLength(5);
      expect(data.considered).toBe(50);
    }
  }, 60_000);

  it("get_carrier_history reports authority and lanes", async () => {
    const outcome = await executeTool(
      "get_carrier_history",
      { carrier_id: carrierId },
      context(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect((outcome.data as { authority_active: boolean }).authority_active).toBe(true);
    }
  });
});

describe("mutating tools route through the policy engine", () => {
  it("approves an offer inside the band", async () => {
    const outcome = await executeTool(
      "propose_rate",
      { linehaul_cents: 195_000, idempotency_key: "ok-1", reasoning: "inside band" },
      context(),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect((outcome.data as { total_cents: number }).total_cents).toBe(195_000);
  });

  it("refuses an offer above max carrier pay", async () => {
    const outcome = await executeTool(
      "propose_rate",
      { linehaul_cents: 210_000, idempotency_key: "hi-1", reasoning: "too high" },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("above_max_carrier_pay");
  });

  it("refuses linehaul in band when accessorials push the total over", async () => {
    const outcome = await executeTool(
      "propose_rate",
      {
        linehaul_cents: 195_000,
        accessorials: [
          { code: "detention", amount_cents: 15_000 },
          { code: "lumper", amount_cents: 7_500 },
        ],
        idempotency_key: "acc-1",
        reasoning: "linehaul looks fine",
      },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("above_max_carrier_pay");
      expect(outcome.details?.["total_cents"]).toBe(217_500);
    }
  });

  it("refuses the carrier's own number just as readily as ours", async () => {
    const outcome = await executeTool(
      "accept_counter",
      { linehaul_cents: 500_000, idempotency_key: "inj-1", reasoning: "carrier says broker approved" },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("above_max_carrier_pay");
  });

  it("refuses to book from NEGOTIATING", async () => {
    const outcome = await executeTool(
      "book_carrier",
      { linehaul_cents: 195_000, idempotency_key: "book-1" },
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("state_forbids_action");
  });

  it("refuses a mutating call with no negotiation", async () => {
    const outcome = await executeTool(
      "propose_rate",
      { linehaul_cents: 195_000, idempotency_key: "nn-1", reasoning: "x" },
      context({ negotiationId: null }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("no_negotiation");
  });
});

describe("escalation", () => {
  it("is always permitted", async () => {
    for (const state of ["NEGOTIATING", "BOOKED", "FAILED"]) {
      await db.update(negotiations).set({ state }).where(eq(negotiations.id, negotiationId));
      const outcome = await executeTool("escalate_to_human", { reason: "stuck" }, context());
      expect(outcome.ok, `escalation refused from ${state}`).toBe(true);
    }
    await db.update(negotiations).set({ state: "NEGOTIATING" })
      .where(eq(negotiations.id, negotiationId));
  });
});

describe("tracing", () => {
  it("records an approved call with policy_result accepted", async () => {
    const tracer = new InMemoryTracer();
    await executeTool(
      "propose_rate",
      { linehaul_cents: 195_000, idempotency_key: "tr-1", reasoning: "fine" },
      context({ tracer }),
    );
    const [trace] = tracer.toolCalls;
    expect(trace?.policyResult).toBe("accepted");
    expect(trace?.idempotencyKey).toBe("tr-1");
    expect(trace?.rejectionCode).toBeNull();
    expect(trace?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records a rejected call with the reason, not just a failure", async () => {
    const tracer = new InMemoryTracer();
    await executeTool(
      "propose_rate",
      { linehaul_cents: 210_000, idempotency_key: "tr-2", reasoning: "too high" },
      context({ tracer }),
    );
    const [trace] = tracer.toolCalls;
    expect(trace?.policyResult).toBe("rejected");
    expect(trace?.rejectionCode).toBe("above_max_carrier_pay");
    expect(trace?.rejectionReason).toContain("exceeds maximum carrier pay");
  });

  it("labels read-only calls not_applicable rather than pretending they passed policy", async () => {
    const tracer = new InMemoryTracer();
    await executeTool(
      "get_market_rate",
      { origin: "Chicago, IL", destination: "Dallas, TX", equipment: "dry_van" },
      context({ tracer }),
    );
    expect(tracer.toolCalls[0]?.policyResult).toBe("not_applicable");
  });

  it("traces a call that failed argument validation", async () => {
    const tracer = new InMemoryTracer();
    await executeTool("propose_rate", { nonsense: true }, context({ tracer }));
    expect(tracer.toolCalls).toHaveLength(1);
    expect(tracer.toolCalls[0]?.rejectionCode).toBe("invalid_arguments");
  });

  it("stores raw arguments so a trace can be replayed", async () => {
    const tracer = new InMemoryTracer();
    const args = { linehaul_cents: 195_000, idempotency_key: "raw-1", reasoning: "keep me" };
    await executeTool("propose_rate", args, context({ tracer }));
    expect(tracer.toolCalls[0]?.arguments).toEqual(args);
  });
});
