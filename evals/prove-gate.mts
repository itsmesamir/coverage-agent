/**
 * Prove the regression gate actually catches regressions.
 *
 * `pnpm eval:prove-gate`
 *
 * PLAN.md asks for the gate to be broken three ways and confirmed to fail each
 * time. This does it mechanically rather than by hand, because "we checked
 * once" decays and a gate nobody re-verifies is a gate that quietly stopped
 * working.
 *
 * Each scenario mutates the SCORED CORPUS rather than the source, which is the
 * honest way to test a comparison: it simulates what the corpus would look
 * like after the regression, without needing a metered run to produce one. The
 * limits of that are stated in the output -- this proves the comparison bites,
 * not that a given source edit produces that corpus.
 */

import { readFileSync } from "node:fs";

import { compareToBaseline, type Baseline } from "./baseline.js";
import { scoreFixture } from "./score-fixture.js";
import type { TraceFixture } from "./fixtures.js";

const fixture = JSON.parse(
  readFileSync("evals/fixtures/traces.json", "utf8"),
) as TraceFixture;
const baseline = JSON.parse(readFileSync("evals/baselines.json", "utf8")) as Baseline;

type Mutator = (f: TraceFixture) => TraceFixture;

const clone = (f: TraceFixture): TraceFixture => JSON.parse(JSON.stringify(f)) as TraceFixture;

/**
 * A loosened ceiling: an offer is approved above what the load can pay.
 * This is what the corpus looks like if someone widens a policy rule.
 */
const loosenPolicyRule: Mutator = (f) => {
  const next = clone(f);
  const trace = next.traces.find((t) =>
    t.toolCalls.some((c) => c.policyResult === "accepted" && c.toolName === "propose_rate"),
  );
  if (!trace) throw new Error("corpus has no accepted offer to mutate");
  const call = trace.toolCalls.find(
    (c) => c.policyResult === "accepted" && c.toolName === "propose_rate",
  )!;
  const data = (call.result as { data: Record<string, number> }).data;
  // Comfortably past the ceiling, as a widened rule would let through.
  data["total_cents"] = trace.load.maxCarrierPayCents + 50_000;
  data["linehaul_cents"] = data["total_cents"];
  return next;
};

/**
 * A degraded prompt: the agent stops offering before it books.
 * Precedence breaks, which is what a worse prompt looks like in the trace.
 */
const degradePrompt: Mutator = (f) => {
  const next = clone(f);
  let changed = 0;
  for (const trace of next.traces) {
    const booking = trace.toolCalls.findIndex((c) => c.toolName === "book_carrier");
    if (booking === -1) continue;
    // Drop every offer that preceded the booking: the agent books something it
    // never offered.
    trace.toolCalls = trace.toolCalls.filter(
      (c, i) => !(i < booking && c.toolName === "propose_rate"),
    ) as typeof trace.toolCalls;
    changed += 1;
    if (changed >= 3) break;
  }
  if (changed === 0) throw new Error("corpus has no booking to mutate");
  return next;
};

/**
 * A changed tool description: the model starts quoting figures nobody
 * approved, which is what a hallucination looks like once it reaches a message.
 */
const changeToolDescription: Mutator = (f) => {
  const next = clone(f);
  let changed = 0;
  for (const trace of next.traces) {
    for (const message of trace.outbound) {
      if (message.extractedWith === null) continue;
      const money = message.claims.find((c) => c.kind === "money");
      if (!money) continue;
      (money as { value: number }).value = 999_999;
      changed += 1;
      break;
    }
    if (changed >= 5) break;
  }
  if (changed === 0) {
    return next; // reported below; no cached claims means nothing to corrupt
  }
  return next;
};

const scenarios: { name: string; how: string; mutate: Mutator; expect: string }[] = [
  {
    name: "loosen a policy rule",
    how: "an approved offer sits above the load's ceiling",
    mutate: loosenPolicyRule,
    expect: "policy_violations",
  },
  {
    name: "degrade the prompt",
    how: "the agent books without having offered first",
    mutate: degradePrompt,
    expect: "tool_call_score",
  },
  {
    name: "change a tool description",
    how: "an outbound message quotes a figure nobody approved",
    mutate: changeToolDescription,
    expect: "hallucination_rate",
  },
];

console.log("baseline:");
const clean = scoreFixture(fixture);
const cleanComparison = compareToBaseline(clean, baseline);
console.log(
  `  violations ${clean.policyViolations}  tool-call ${clean.meanToolCallScore.toFixed(4)}  ` +
    `hallucination ${clean.hallucinationRate.toFixed(4)}  => ${cleanComparison.passed ? "PASS" : "FAIL"}`,
);
if (!cleanComparison.passed) {
  console.error("\nThe unmodified corpus already fails its own baseline. Fix that first.");
  process.exit(1);
}

console.log(`\nbreaking it three ways:\n`);
let caught = 0;
let uncaught = 0;

for (const scenario of scenarios) {
  const mutated = scenario.mutate(fixture);
  const score = scoreFixture(mutated);
  const comparison = compareToBaseline(score, baseline);
  const breached = comparison.breaches.map((b) => b.metric);
  const hit = breached.includes(scenario.expect);

  console.log(`${scenario.name}`);
  console.log(`  ${scenario.how}`);
  console.log(
    `  violations ${score.policyViolations}  tool-call ${score.meanToolCallScore.toFixed(4)}  ` +
      `hallucination ${score.hallucinationRate.toFixed(4)}`,
  );

  if (comparison.passed) {
    console.log(`  NOT CAUGHT -- the gate passed a corpus it should have rejected`);
    uncaught += 1;
  } else if (hit) {
    console.log(`  caught by ${breached.join(", ")}`);
    caught += 1;
  } else {
    console.log(
      `  caught, but by ${breached.join(", ")} rather than the expected ${scenario.expect}`,
    );
    caught += 1;
  }
  for (const b of comparison.breaches) console.log(`      ${b.metric}: ${b.detail}`);
  console.log();
}

console.log(`caught ${caught}/${scenarios.length}, missed ${uncaught}`);
console.log(
  `\nWhat this shows: the comparison rejects corpora carrying each regression.\n` +
    `What it does not show: that a given source edit produces that corpus. That\n` +
    `still needs a real run, and is why the source-level break is worth doing by\n` +
    `hand at least once.`,
);
process.exitCode = uncaught > 0 ? 1 : 0;
