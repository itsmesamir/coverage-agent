/**
 * `pnpm eval:small` -- the dev-loop subset
 * `pnpm eval`       -- every case
 *
 * Generating traces costs LLM calls. Scoring them does not: once a run has
 * landed, `pnpm eval:replay` re-scores the same corpus for free.
 */

import { createClient, createDb } from "../api/app/db/client.js";
import { buildAgentProvider, buildSimulationProvider } from "../api/app/agent/providers/index.js";
import { CASES, CASES_BY_ID, SMALL_SUITE } from "./cases/catalog.js";
import { runSuite } from "./runner.js";

const small = process.argv.includes("--small");
const cases = small
  ? SMALL_SUITE.map((id) => CASES_BY_ID.get(id)!).filter(Boolean)
  : CASES;

const client = createClient();
const db = createDb(client);

try {
  const agent = buildAgentProvider();
  let simulation;
  try {
    simulation = buildSimulationProvider();
  } catch {
    // No Groq key: personas fall back to templates. The decisions are
    // identical either way, only the prose changes.
    simulation = undefined;
  }

  console.log(`suite: ${small ? "small" : "full"}  cases: ${cases.length}`);
  console.log(`agent: ${agent.name}/${agent.model}`);
  console.log(`carrier phrasing: ${simulation ? "model" : "templates"}\n`);

  const started = Date.now();
  const result = await runSuite(db, cases, agent, simulation, small ? "small" : "full");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log("case                        outcome     turns  tools  violations  result");
  console.log("-".repeat(78));
  for (const r of result.results) {
    console.log(
      `${r.caseId.padEnd(26)}  ${r.outcome.padEnd(10)}  ${String(r.turns).padStart(5)}  ` +
        `${r.toolCallScore.toFixed(2).padStart(5)}  ${String(r.policyViolations).padStart(10)}  ` +
        `${r.passed ? "pass" : "FAIL"}`,
    );
    for (const f of r.failures) console.log(`    ${f}`);
  }

  console.log("-".repeat(78));
  console.log(
    `passed ${result.passed}/${result.results.length}  in ${seconds}s` +
      (result.errored > 0 ? `  (${result.errored} could not run)` : ""),
  );
  console.log(`POLICY VIOLATIONS: ${result.totalViolations}`);
  console.log(`mean tool-call score: ${result.meanToolCallScore.toFixed(3)}`);
  console.log(`run id: ${result.runId}`);

  // Zero violations is the claim the whole design rests on, so it is the one
  // that fails the command rather than merely being reported.
  process.exitCode = result.totalViolations > 0 ? 1 : 0;
} finally {
  await client.end();
}
