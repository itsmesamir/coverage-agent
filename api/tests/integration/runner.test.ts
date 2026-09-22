/**
 * The runner's judgement, against a scripted model.
 *
 * These assert what the HARNESS concludes from a run, not what a model happens
 * to do -- so an eval that would wrongly pass a violating run, or wrongly fail
 * a clean one, is caught here rather than in the numbers.
 */

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, createDb, type Database } from "../../app/db/client.js";
import {
  bookings, carriers, evalCases, evalResults, evalRuns, loads, negotiations,
} from "../../app/db/schema.js";
import { StubProvider } from "../../app/agent/providers/gemini.js";
import type { LlmResponse } from "../../app/agent/provider.js";
import { runSuite } from "../../../evals/runner.js";
import type { EvalCase } from "../../../evals/cases/catalog.js";

let client: ReturnType<typeof createClient>;
let db: Database;
const runIds: string[] = [];
const negotiationIds: string[] = [];
const caseIds: string[] = [];

function tool(name: string, args: Record<string, unknown>): Partial<LlmResponse> {
  return { toolCalls: [{ name, args }] };
}

beforeAll(async () => {
  client = createClient();
  db = createDb(client);
});

afterAll(async () => {
  // Only this file's fixtures. Deleting every "E"-prefixed load would take out
  // the real eval suite's rows too, whose eval_results still reference them.
  for (const negotiationId of negotiationIds) {
    const [neg] = await db.select({ loadId: negotiations.loadId, carrierId: negotiations.carrierId })
      .from(negotiations).where(eq(negotiations.id, negotiationId));
    if (!neg) continue;
    // eval_results references negotiations, so the run (and its cascaded
    // results) has to go before the negotiation it points at.
    if (runIds.length > 0) {
      await db.delete(evalRuns).where(inArray(evalRuns.id, runIds));
      runIds.length = 0;
    }
    if (caseIds.length > 0) {
      await db.delete(evalCases).where(inArray(evalCases.caseId, caseIds));
    }
    await db.delete(bookings).where(eq(bookings.negotiationId, negotiationId));
    await db.delete(negotiations).where(eq(negotiations.id, negotiationId));
    await db.delete(carriers).where(eq(carriers.carrierId, neg.carrierId));
    await db.delete(loads).where(eq(loads.loadId, neg.loadId));
  }
  if (runIds.length > 0) {
    await db.delete(evalRuns).where(inArray(evalRuns.id, runIds));
  }
  if (caseIds.length > 0) {
    await db.delete(evalCases).where(inArray(evalCases.caseId, caseIds));
  }
  await client.end();
});

function caseFor(over: Partial<EvalCase["expected"]> = {}): EvalCase {
  return {
    caseId: `t-${randomUUID().slice(0, 8)}`,
    name: "harness test case",
    personaId: "accepts_immediately",
    expected: {
      acceptableOutcomes: ["BOOKED"],
      requiredTools: ["propose_rate"],
      bookingMustBeInBand: true,
      maxTurns: 10,
      ...over,
    },
  };
}

async function run(testCase: EvalCase, script: Partial<LlmResponse>[]) {
  const result = await runSuite(
    db,
    [testCase],
    new StubProvider("stub-model", script),
    undefined,
    "test",
  );
  runIds.push(result.runId);
  for (const r of result.results) {
    negotiationIds.push(r.negotiationId);
    caseIds.push(r.caseId);
  }
  return result;
}

describe("a clean run", () => {
  it("passes and records zero violations", async () => {
    const result = await run(caseFor(), [
      tool("propose_rate", { linehaul_cents: 195_000, idempotency_key: "k1", reasoning: "open" }),
      tool("accept_counter", { linehaul_cents: 195_000, idempotency_key: "k2", reasoning: "agreed" }),
      tool("book_carrier", { linehaul_cents: 195_000, idempotency_key: "k3" }),
    ]);

    expect(result.results[0]?.passed).toBe(true);
    expect(result.totalViolations).toBe(0);
    expect(result.results[0]?.outcome).toBe("BOOKED");
  }, 30_000);

  it("writes the run and its per-case result to the database", async () => {
    const result = await run(caseFor(), [
      tool("propose_rate", { linehaul_cents: 195_000, idempotency_key: "k1", reasoning: "open" }),
      tool("accept_counter", { linehaul_cents: 195_000, idempotency_key: "k2", reasoning: "y" }),
      tool("book_carrier", { linehaul_cents: 195_000, idempotency_key: "k3" }),
    ]);

    const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, result.runId));
    expect(row?.suite).toBe("test");
    expect(row?.promptVersion).toBe("v1");
    expect(row?.finishedAt).not.toBeNull();
    // The model that produced the run is recorded: a metric that moved because
    // the model changed is not a code regression.
    expect(row?.model).toBe("stub-model");

    const results = await db.select().from(evalResults).where(eq(evalResults.runId, result.runId));
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
  }, 30_000);
});

describe("the harness catches a bad run", () => {
  it("fails a case whose outcome was not acceptable", async () => {
    // Expects BOOKED; the agent escalates instead.
    const result = await run(caseFor(), [
      tool("propose_rate", { linehaul_cents: 195_000, idempotency_key: "k1", reasoning: "open" }),
      tool("escalate_to_human", { reason: "giving up" }),
    ]);
    expect(result.results[0]?.passed).toBe(false);
    expect(result.results[0]?.failures.join(" ")).toContain("expected one of BOOKED");
  }, 30_000);

  it("fails a case that used a forbidden tool", async () => {
    const result = await run(
      caseFor({
        acceptableOutcomes: ["BOOKED", "ESCALATED", "FAILED"],
        forbiddenTools: ["book_carrier"],
      }),
      [
        tool("propose_rate", { linehaul_cents: 195_000, idempotency_key: "k1", reasoning: "o" }),
        tool("accept_counter", { linehaul_cents: 195_000, idempotency_key: "k2", reasoning: "y" }),
        tool("book_carrier", { linehaul_cents: 195_000, idempotency_key: "k3" }),
      ],
    );
    expect(result.results[0]?.passed).toBe(false);
    expect(result.results[0]?.failures.join(" ")).toContain("forbidden");
  }, 30_000);

  it("fails a case that never called a required tool", async () => {
    const result = await run(
      caseFor({
        acceptableOutcomes: ["ESCALATED"],
        requiredTools: ["propose_rate", "search_carriers"],
      }),
      [
        tool("propose_rate", { linehaul_cents: 195_000, idempotency_key: "k1", reasoning: "o" }),
        tool("escalate_to_human", { reason: "done" }),
      ],
    );
    expect(result.results[0]?.failures.join(" ")).toContain("never called search_carriers");
  }, 30_000);

  it("fails a case that expected a rejection and saw none", async () => {
    const result = await run(
      caseFor({
        acceptableOutcomes: ["ESCALATED"],
        expectedRejections: ["authority_inactive"],
      }),
      [
        tool("propose_rate", { linehaul_cents: 195_000, idempotency_key: "k1", reasoning: "o" }),
        tool("escalate_to_human", { reason: "done" }),
      ],
    );
    expect(result.results[0]?.failures.join(" ")).toContain("authority_inactive");
  }, 30_000);
});

describe("a case that cannot run", () => {
  it("is recorded as an error and does not discard the cases that already ran", async () => {
    // A suite costs quota and minutes. Losing completed results to a dropped
    // connection on a later case is the wrong trade.
    class ExplodingProvider {
      readonly name = "stub";
      readonly model = "stub-model";
      private calls = 0;
      async generate() {
        this.calls += 1;
        if (this.calls > 1) throw new Error("boom");
        return {
          text: "", toolCalls: [{ name: "escalate_to_human", args: { reason: "done" } }],
          inputTokens: 1, outputTokens: 1, modelVersion: null, raw: {},
        };
      }
    }

    const good = caseFor({ acceptableOutcomes: ["ESCALATED"], requiredTools: [] });
    const bad = caseFor({ acceptableOutcomes: ["ESCALATED"], requiredTools: [] });
    const result = await runSuite(db, [good, bad], new ExplodingProvider(), undefined, "test");
    runIds.push(result.runId);
    for (const r of result.results) {
      if (r.negotiationId) negotiationIds.push(r.negotiationId);
      caseIds.push(r.caseId);
    }

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.passed).toBe(true);
    expect(result.results[1]?.outcome).toBe("ERROR");
    expect(result.errored).toBe(1);
    // An error is not an agent failure: it must not be counted as one.
    expect(result.failed).toBe(0);
  }, 30_000);
});

describe("fixtures", () => {
  it("gives each case its own load so runs accumulate instead of overwriting", async () => {
    const a = await run(caseFor(), [tool("escalate_to_human", { reason: "x" })]);
    const b = await run(caseFor(), [tool("escalate_to_human", { reason: "x" })]);

    const [negA] = await db.select().from(negotiations)
      .where(eq(negotiations.id, a.results[0]!.negotiationId));
    const [negB] = await db.select().from(negotiations)
      .where(eq(negotiations.id, b.results[0]!.negotiationId));

    expect(negA?.loadId).not.toBe(negB?.loadId);
    // Both traces still exist: the earlier one was not deleted to make room.
    expect(negA).toBeDefined();
    expect(negB).toBeDefined();
  }, 30_000);
});
