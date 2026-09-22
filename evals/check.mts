/**
 * Re-score the committed corpus and compare against the baseline.
 *
 * `pnpm eval:check`            fail if a threshold is breached
 * `pnpm eval:check --update`   write the current numbers as the new baseline
 *
 * No database, no model, no secrets. This is what CI runs on every push.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// The model that produced a corpus is provenance that matters: a metric that
// moved because the model changed is not a code regression, and a baseline
// that cannot say which model it came from cannot make that distinction.
import { agentModels } from "../api/app/config.js";
import { fixtureStats, type TraceFixture } from "./fixtures.js";
import { scoreFixture } from "./score-fixture.js";
import { compareToBaseline, THRESHOLDS, type Baseline } from "./baseline.js";

const FIXTURE = "evals/fixtures/traces.json";
const BASELINE = "evals/baselines.json";
const update = process.argv.includes("--update");

if (!existsSync(FIXTURE)) {
  console.error(`No corpus at ${FIXTURE}. Produce one with: pnpm eval:export`);
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as TraceFixture;
const stats = fixtureStats(fixture);
const score = scoreFixture(fixture);

console.log(`corpus: ${stats.traces} traces, ${stats.toolCalls} tool calls, ` +
  `${stats.messagesWithClaims}/${stats.messages} messages with cached claims`);
console.log(`captured ${fixture.capturedAt.slice(0, 10)} at ${fixture.gitSha.slice(0, 8)}\n`);

console.log(`policy violations:    ${score.policyViolations}`);
console.log(`decisions checked:    ${score.decisionsChecked}`);
console.log(`mean tool-call score: ${score.meanToolCallScore.toFixed(4)} over ${score.toolCallsScored} traces`);
console.log(
  `hallucination rate:   ${score.hallucinationRate.toFixed(4)} ` +
    `(${score.claimsSettleable} settleable, ${score.claimsAmbiguous} ambiguous)`,
);

for (const v of score.violations) {
  console.log(`  VIOLATION ${v.negotiationId.slice(0, 8)} ${v.kind}: ${v.detail}`);
}

if (update) {
  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // provenance only
  }
  const baseline: Baseline = {
    recordedAt: new Date().toISOString(),
    gitSha,
    provider: process.env["AGENT_PROVIDER"] ?? "gemini",
    model: agentModels()[0] ?? "unknown",
    promptVersion: "v1",
    corpus: {
      traces: score.traces,
      decisionsChecked: score.decisionsChecked,
      messagesWithClaims: score.messagesWithClaims,
    },
    metrics: {
      policyViolations: score.policyViolations,
      meanToolCallScore: score.meanToolCallScore,
      hallucinationRate: score.hallucinationRate,
    },
  };
  writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nwrote ${BASELINE}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`\nNo baseline at ${BASELINE}. Record one with: pnpm eval:check --update`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
const comparison = compareToBaseline(score, baseline);

console.log(`\nbaseline ${baseline.gitSha.slice(0, 8)} recorded ${baseline.recordedAt.slice(0, 10)}`);
console.log(
  `thresholds: violations <= ${THRESHOLDS.maxPolicyViolations}, ` +
    `tool-call drop <= ${THRESHOLDS.toolCallScoreDrop}, ` +
    `hallucination rise <= ${THRESHOLDS.hallucinationRateRise}`,
);

for (const note of comparison.notes) console.log(`  note: ${note}`);

if (comparison.passed) {
  console.log(`\nPASS`);
  process.exit(0);
}

console.error(`\nFAIL`);
for (const b of comparison.breaches) console.error(`  ${b.metric}: ${b.detail}`);
process.exit(1);
