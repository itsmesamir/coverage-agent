/**
 * Score stored outbound messages for grounded accuracy.
 *
 * `pnpm eval:hallucination [--limit N] [--dump FILE]`
 *
 * Extraction costs one cheap model call per message (Groq). Verification is
 * free. `--dump` writes the per-claim verdicts to a file so they can be
 * compared against hand labels -- the evaluator's own error rate is a number
 * this project has to be able to state, and it cannot be derived from the
 * checker agreeing with itself.
 */

import { writeFileSync } from "node:fs";

import { asc, eq } from "drizzle-orm";

import { createClient, createDb } from "../api/app/db/client.js";
import { carriers, messages, negotiations } from "../api/app/db/schema.js";
import { buildSimulationProvider } from "../api/app/agent/providers/index.js";
import { extractClaims } from "./metrics/claim-extraction.js";
import { scoreHallucination, type GroundTruth } from "./metrics/hallucination.js";
import { acceptedDecisions, listTracedNegotiations, loadTrace } from "./replay.js";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? 20 : Number(process.argv[limitArg + 1] ?? 20);
const dumpArg = process.argv.indexOf("--dump");
const dumpTo = dumpArg === -1 ? null : process.argv[dumpArg + 1];

const client = createClient();
const db = createDb(client);

try {
  const provider = buildSimulationProvider();
  const ids = await listTracedNegotiations(db);

  interface Row {
    negotiationId: string;
    messageId: string;
    body: string;
    supported: number;
    unsupported: number;
    ambiguous: number;
    claims: {
      kind: string;
      text: string;
      value: unknown;
      verdict: string;
      reason: string;
      label: string | null;
    }[];
  }

  const rows: Row[] = [];
  const skipped: { messageId: string; reason: string }[] = [];
  let totalSupported = 0;
  let totalUnsupported = 0;
  let totalAmbiguous = 0;

  for (const id of ids) {
    if (rows.length >= limit) break;
    const trace = await loadTrace(db, id);
    if (!trace) continue;

    const [carrier] = await db
      .select({ name: carriers.name })
      .from(negotiations)
      .innerJoin(carriers, eq(negotiations.carrierId, carriers.carrierId))
      .where(eq(negotiations.id, id));

    const decisions = acceptedDecisions(trace);
    const approved = new Set<number>();
    for (const d of decisions) {
      approved.add(d.linehaulCents);
      approved.add(d.totalCents);
    }

    const truth: GroundTruth = {
      loadId: trace.load.loadId,
      origin: trace.load.origin,
      destination: trace.load.destination,
      equipment: trace.load.equipment,
      weightLbs: trace.load.weightLbs,
      commodity: trace.load.commodity,
      pickupAt: trace.load.pickupAt,
      carrierName: carrier?.name ?? "",
      approvedAmountsCents: [...approved],
    };

    const outbound = await db
      .select({ id: messages.id, body: messages.body, direction: messages.direction })
      .from(messages)
      .where(eq(messages.negotiationId, id))
      .orderBy(asc(messages.createdAt));

    for (const message of outbound.filter((m) => m.direction === "outbound")) {
      if (rows.length >= limit) break;

      // One message failing must not discard the ones already scored. Groq's
      // free tier meters output tokens per minute and an extraction returns a
      // few hundred, so a long batch will meet the ceiling however politely it
      // backs off. Skipping the message and reporting the count is better than
      // losing the run.
      let claims;
      try {
        claims = await extractClaims(provider, message.body);
      } catch (error) {
        skipped.push({
          messageId: message.id,
          reason: error instanceof Error ? error.message.slice(0, 120) : String(error),
        });
        continue;
      }

      const score = scoreHallucination(claims, truth);
      totalSupported += score.supported;
      totalUnsupported += score.unsupported;
      totalAmbiguous += score.ambiguous;
      rows.push({
        negotiationId: id,
        messageId: message.id,
        body: message.body,
        supported: score.supported,
        unsupported: score.unsupported,
        ambiguous: score.ambiguous,
        claims: score.checked.map((c) => ({
          kind: c.claim.kind,
          text: c.claim.text,
          value: c.claim.value,
          verdict: c.verdict,
          reason: c.reason,
          // Left empty for a human to fill in with supported / unsupported /
          // ambiguous. The checker's own error rate cannot be derived from the
          // checker agreeing with itself.
          label: null,
        })),
      });
    }
  }

  console.log(`scored ${rows.length} outbound message(s)\n`);
  console.log("message                               supported  unsupported  ambiguous");
  console.log("-".repeat(78));
  for (const r of rows) {
    console.log(
      `${r.messageId.slice(0, 36)}  ${String(r.supported).padStart(9)}  ` +
        `${String(r.unsupported).padStart(11)}  ${String(r.ambiguous).padStart(9)}`,
    );
    for (const c of r.claims.filter((x) => x.verdict === "unsupported")) {
      console.log(`    UNSUPPORTED ${c.kind}: "${c.text}" -- ${c.reason}`);
    }
  }

  const settleable = totalSupported + totalUnsupported;
  console.log("-".repeat(78));
  if (skipped.length > 0) {
    console.log(`skipped ${skipped.length} message(s) that could not be extracted:`);
    for (const s of skipped) console.log(`    ${s.messageId.slice(0, 12)} ${s.reason}`);
  }
  console.log(`claims: ${settleable} settleable, ${totalAmbiguous} ambiguous`);
  console.log(
    `HALLUCINATION RATE: ${settleable === 0 ? "n/a" : (totalUnsupported / settleable).toFixed(4)}` +
      ` (${totalUnsupported}/${settleable})`,
  );

  if (dumpTo) {
    writeFileSync(dumpTo, JSON.stringify(rows, null, 2));
    console.log(`\nwrote ${rows.length} scored messages to ${dumpTo}`);
    console.log("Hand-label these, then run: pnpm eval:evaluator <file>");
  }
} finally {
  await client.end();
}
