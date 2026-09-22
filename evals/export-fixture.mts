/**
 * Capture the stored corpus into a committed fixture.
 *
 * `pnpm eval:export [--claims] [--out FILE]`
 *
 * `--claims` also runs claim extraction, which needs a model and is the slow,
 * metered part. Without it, existing cached claims are carried over from the
 * previous fixture so a re-export does not silently throw away work that cost
 * quota to produce.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { asc, eq } from "drizzle-orm";

import { createClient, createDb } from "../api/app/db/client.js";
import {
  bookings, carriers, llmCalls, loads, messages, negotiations, toolCalls,
} from "../api/app/db/schema.js";
import { buildSimulationProvider } from "../api/app/agent/providers/index.js";
import { extractClaims, EXTRACTION_PROMPT_VERSION } from "./metrics/claim-extraction.js";
import { fixtureStats, FIXTURE_VERSION, type FixtureTrace, type TraceFixture } from "./fixtures.js";
import { listTracedNegotiations } from "./replay.js";

const withClaims = process.argv.includes("--claims");
const outArg = process.argv.indexOf("--out");
const outFile = outArg === -1 ? "evals/fixtures/traces.json" : process.argv[outArg + 1]!;

/** Claims already paid for, keyed by message id. */
const previous = new Map<string, { claims: unknown; extractedWith: string | null }>();
if (existsSync(outFile)) {
  const old = JSON.parse(readFileSync(outFile, "utf8")) as TraceFixture;
  for (const trace of old.traces) {
    for (const m of trace.outbound) {
      if (m.extractedWith !== null) {
        previous.set(m.messageId, { claims: m.claims, extractedWith: m.extractedWith });
      }
    }
  }
}

const client = createClient();
const db = createDb(client);

try {
  const provider = withClaims ? buildSimulationProvider() : undefined;
  const allIds = await listTracedNegotiations(db);

  // Only traces a real model produced.
  //
  // Most stored traces come from the test suite's stub provider, including
  // sequences that deliberately misbehave to prove a metric can catch them.
  // Baselining on those would mean the regression check moved whenever a test
  // was edited, and a test change would read as an agent regression. It would
  // also mean the corpus mostly measured a scripted stub rather than the
  // system.
  const realModelRows = await db
    .selectDistinct({ negotiationId: llmCalls.negotiationId, model: llmCalls.model })
    .from(llmCalls);
  const realModelIds = new Set(
    realModelRows
      .filter((r) => r.negotiationId !== null && !r.model.startsWith("stub"))
      .map((r) => r.negotiationId as string),
  );
  const ids = allIds.filter((id) => realModelIds.has(id));
  const excluded = allIds.length - ids.length;

  const traces: FixtureTrace[] = [];
  let extracted = 0;
  let reused = 0;
  const skipped: string[] = [];

  for (const id of ids) {
    const [row] = await db
      .select({
        state: negotiations.state,
        carrierName: carriers.name,
        loadId: loads.loadId,
        origin: loads.origin,
        destination: loads.destination,
        equipment: loads.equipment,
        weightLbs: loads.weightLbs,
        commodity: loads.commodity,
        pickupAt: loads.pickupAt,
        maxCarrierPayCents: loads.maxCarrierPayCents,
        floorCents: loads.floorCents,
      })
      .from(negotiations)
      .innerJoin(loads, eq(negotiations.loadId, loads.loadId))
      .innerJoin(carriers, eq(negotiations.carrierId, carriers.carrierId))
      .where(eq(negotiations.id, id));
    if (!row) continue;

    const calls = await db
      .select({
        id: toolCalls.id,
        toolName: toolCalls.toolName,
        policyResult: toolCalls.policyResult,
        rejectionCode: toolCalls.rejectionCode,
        result: toolCalls.result,
      })
      .from(toolCalls)
      .where(eq(toolCalls.negotiationId, id))
      .orderBy(asc(toolCalls.createdAt));

    const booked = await db
      .select({
        linehaulCents: bookings.linehaulCents,
        totalConsiderationCents: bookings.totalConsiderationCents,
      })
      .from(bookings)
      .where(eq(bookings.negotiationId, id));

    const outboundRows = await db
      .select({ id: messages.id, body: messages.body, direction: messages.direction })
      .from(messages)
      .where(eq(messages.negotiationId, id))
      .orderBy(asc(messages.createdAt));

    const outbound = [];
    for (const m of outboundRows.filter((x) => x.direction === "outbound")) {
      const cached = previous.get(m.id);
      if (cached) {
        reused += 1;
        outbound.push({
          messageId: m.id,
          body: m.body,
          claims: cached.claims as never,
          extractedWith: cached.extractedWith,
        });
        continue;
      }
      if (!provider) {
        outbound.push({ messageId: m.id, body: m.body, claims: [], extractedWith: null });
        continue;
      }
      try {
        const claims = await extractClaims(provider, m.body);
        extracted += 1;
        outbound.push({
          messageId: m.id,
          body: m.body,
          claims,
          extractedWith: EXTRACTION_PROMPT_VERSION,
        });
      } catch (error) {
        // Metered provider; a partial corpus beats a lost export.
        skipped.push(m.id);
        outbound.push({ messageId: m.id, body: m.body, claims: [], extractedWith: null });
      }
    }

    traces.push({
      negotiationId: id,
      finalState: row.state,
      carrierName: row.carrierName,
      load: {
        loadId: row.loadId,
        origin: row.origin,
        destination: row.destination,
        equipment: row.equipment,
        weightLbs: row.weightLbs,
        commodity: row.commodity,
        pickupAt: row.pickupAt.toISOString(),
        maxCarrierPayCents: row.maxCarrierPayCents,
        floorCents: row.floorCents,
      },
      toolCalls: calls,
      bookings: booked,
      outbound,
    });
  }

  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout; the sha is provenance, not a scoring input.
  }

  const fixture: TraceFixture = {
    version: FIXTURE_VERSION,
    capturedAt: new Date().toISOString(),
    gitSha,
    traces,
  };
  writeFileSync(outFile, `${JSON.stringify(fixture, null, 2)}\n`);

  const stats = fixtureStats(fixture);
  console.log(`wrote ${outFile}`);
  console.log(`  traces:   ${stats.traces}`);
  console.log(`  tool calls: ${stats.toolCalls}`);
  console.log(`  messages: ${stats.messages} (${stats.messagesWithClaims} with cached claims)`);
  console.log(`  outcomes: ${JSON.stringify(stats.outcomes)}`);
  console.log(`  excluded ${excluded} stub-provider trace(s) from the test suite`);
  if (withClaims) console.log(`  extracted ${extracted}, reused ${reused} cached`);
  if (skipped.length > 0) console.log(`  extraction failed for ${skipped.length} message(s)`);
} finally {
  await client.end();
}
