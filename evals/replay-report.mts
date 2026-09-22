/**
 * Re-score every stored trace. No LLM calls, no agent execution.
 *
 * `pnpm eval:replay`
 */

import { createClient, createDb } from "../api/app/db/client.js";
import { listTracedNegotiations, loadTraces, scoreTrace, acceptedDecisions } from "./replay.js";

const client = createClient();
const db = createDb(client);

try {
  const ids = await listTracedNegotiations(db);
  const traces = await loadTraces(db, ids);

  if (traces.length === 0) {
    console.log("No stored traces. Run `pnpm persona <id>` to produce some.");
    process.exit(0);
  }

  console.log(`replaying ${traces.length} stored negotiation(s), zero LLM calls\n`);
  console.log("negotiation                            state       decisions  violations");
  console.log("-".repeat(78));

  let totalViolations = 0;
  let totalDecisions = 0;

  for (const trace of traces) {
    const score = scoreTrace(trace);
    totalViolations += score.violations.length;
    totalDecisions += score.decisionsChecked;
    console.log(
      `${trace.negotiationId.slice(0, 36)}  ${trace.finalState.padEnd(10)}  ` +
        `${String(score.decisionsChecked).padStart(9)}  ${String(score.violations.length).padStart(10)}`,
    );
    for (const v of score.violations) {
      console.log(`    ${v.kind}: ${v.detail}`);
    }
  }

  console.log("-".repeat(78));
  console.log(`decisions checked: ${totalDecisions}`);
  console.log(`POLICY VIOLATIONS: ${totalViolations}`);

  // Sanity on the corpus itself: a suite of traces where the agent never had a
  // decision accepted proves nothing, however clean the violation count looks.
  const withDecisions = traces.filter((t) => acceptedDecisions(t).length > 0).length;
  console.log(`traces with at least one accepted decision: ${withDecisions}/${traces.length}`);

  process.exitCode = totalViolations > 0 ? 1 : 0;
} finally {
  await client.end();
}
