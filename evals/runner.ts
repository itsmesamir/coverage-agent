/**
 * Run golden cases end to end and record what happened.
 *
 * Each case gets its OWN load row, cloned from the reference fixture. One
 * negotiation per load/carrier pair is a UNIQUE constraint -- correct for
 * production, where contacting the same carrier twice about one load is a bug
 * -- but it means reusing a single load would make each run delete the last
 * run's trace. Per-case loads let the corpus accumulate, which is what makes
 * replay worth having.
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import { eq } from "drizzle-orm";

import type { Database } from "../api/app/db/client.js";
import {
  carrierLanes, carriers, evalCases, evalResults, evalRuns, loads, negotiations,
} from "../api/app/db/schema.js";
import { runNegotiation } from "../api/app/agent/loop.js";
import { DbTracer } from "../api/app/obs/trace.js";
import type { LlmProvider } from "../api/app/agent/provider.js";
import type { CarrierResponder } from "../api/app/channels/email.js";
import type { RenderedMessage } from "../api/app/agent/render.js";
import { PROMPT_VERSION } from "../api/app/agent/prompt.js";
import { getPersona } from "./personas/catalog.js";
import { SimulatedCarrier } from "./personas/carrier.js";
import type { EvalCase } from "./cases/catalog.js";
import { loadTrace, scoreTrace } from "./replay.js";
import { scoreToolCalls } from "./metrics/tool-calls.js";

export interface CaseResult {
  readonly caseId: string;
  readonly negotiationId: string;
  readonly outcome: string;
  readonly turns: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly policyViolations: number;
  readonly toolCallScore: number;
  readonly model: string;
  /** Set when the case could not be run at all, as opposed to running and failing. */
  readonly error?: string;
}

/** Flips authority partway through, for the persona built around that. */
class AuthorityLapsing implements CarrierResponder {
  constructor(
    private readonly inner: CarrierResponder,
    private readonly db: Database,
    private readonly carrierId: string,
    private readonly atTurn: number,
  ) {}

  async reply(outbound: RenderedMessage, turn: number): Promise<string | null> {
    if (turn >= this.atTurn) {
      await this.db.update(carriers).set({ authorityActive: false })
        .where(eq(carriers.carrierId, this.carrierId));
    }
    return this.inner.reply(outbound, turn);
  }
}

/** The seeded load every case's economics are modelled on. */
const REFERENCE_LOAD_ID = "L-4471";

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * A dedicated load and carrier per case, so runs accumulate instead of
 * overwriting each other, and so one case's authority lapse cannot leak into
 * another's carrier.
 */
async function provisionFixture(
  db: Database,
  runId: string,
  testCase: EvalCase,
): Promise<{ loadId: string; carrierId: string }> {
  const suffix = `${runId.slice(0, 4)}-${testCase.caseId.slice(0, 6)}`;
  const loadId = `E${suffix}`.slice(0, 16);
  const carrierId = `EC${suffix}`.slice(0, 16);

  await db.insert(loads).values({
    loadId,
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    weightLbs: 42_000,
    commodity: "general freight",
    pickupAt: new Date(Date.now() + 86_400_000),
    customerRateCents: 240_000,
    targetMarginBps: 1500,
    maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  });

  await db.insert(carriers).values({
    carrierId,
    name: "Cedar Line Transport",
    mcNumber: `MC-E${suffix}`.slice(0, 24),
    dotNumber: `DOT-E${suffix}`.slice(0, 24),
    authorityActive: true,
    equipment: ["dry_van"],
    fleetSize: 12,
    onTimeBps: 9300,
    homeRegion: "midwest",
  });

  // Lane history on the load's own lane.
  //
  // Without it the agent searches, is shown 200 unrelated seeded carriers, and
  // reasons about a carrier that is not the one its negotiation is bound to --
  // which is what produced an `unknown_carrier` lookup and a confused
  // escalation on the first suite run. The negotiation's carrier has to be
  // discoverable by the tool the agent is told to use.
  await db.insert(carrierLanes).values({
    carrierId,
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    loadsRun: 14,
    lastRateCents: 192_000,
    lastRunDaysAgo: 9,
  });

  return { loadId, carrierId };
}

export async function runCase(
  db: Database,
  runId: string,
  testCase: EvalCase,
  agent: LlmProvider,
  simulation: LlmProvider | undefined,
): Promise<CaseResult> {
  const persona = getPersona(testCase.personaId);
  const { loadId, carrierId } = await provisionFixture(db, runId, testCase);

  const negotiationId = randomUUID();
  await db.insert(negotiations).values({ id: negotiationId, loadId, carrierId, state: "NEW" });

  const simulated = new SimulatedCarrier(persona, simulation);
  const responder: CarrierResponder =
    persona.authorityLapsesAtTurn === undefined
      ? simulated
      : new AuthorityLapsing(simulated, db, carrierId, persona.authorityLapsesAtTurn);

  const loopResult = await runNegotiation(
    { db, tracer: new DbTracer(db), provider: agent, carrier: responder, now: () => new Date() },
    negotiationId,
  );

  const trace = await loadTrace(db, negotiationId);
  if (!trace) throw new Error(`No trace recorded for ${testCase.caseId}`);

  const policy = scoreTrace(trace);
  const tools = scoreToolCalls(
    trace.toolCalls.map((c) => ({ toolName: c.toolName, policyResult: c.policyResult })),
    {
      requiredTools: testCase.expected.requiredTools,
      ...(testCase.expected.forbiddenTools
        ? { forbiddenTools: testCase.expected.forbiddenTools }
        : {}),
    },
  );

  const failures: string[] = [];
  if (!testCase.expected.acceptableOutcomes.includes(loopResult.finalState as never)) {
    failures.push(
      `outcome ${loopResult.finalState}, expected one of ${testCase.expected.acceptableOutcomes.join("/")}`,
    );
  }
  if (policy.violations.length > 0) {
    failures.push(`${policy.violations.length} policy violation(s): ${policy.violations.map((v) => v.kind).join(", ")}`);
  }
  if (tools.missingRequired.length > 0) {
    failures.push(`never called ${tools.missingRequired.join(", ")}`);
  }
  if (tools.forbiddenUsed.length > 0) {
    failures.push(`forbidden tool took effect: ${tools.forbiddenUsed.join(", ")}`);
  }
  if (!tools.precedenceHeld) {
    failures.push(`mutating call out of order: ${tools.outOfOrder.join(", ")}`);
  }
  if (loopResult.turns > testCase.expected.maxTurns) {
    failures.push(`${loopResult.turns} turns, budget ${testCase.expected.maxTurns}`);
  }
  for (const code of testCase.expected.expectedRejections ?? []) {
    if (!trace.toolCalls.some((c) => c.rejectionCode === code)) {
      failures.push(`expected a '${code}' rejection and saw none`);
    }
  }

  const result: CaseResult = {
    caseId: testCase.caseId,
    negotiationId,
    outcome: loopResult.finalState,
    turns: loopResult.turns,
    passed: failures.length === 0,
    failures,
    policyViolations: policy.violations.length,
    toolCallScore: tools.score,
    model: agent.model,
  };

  // The case definition points at the stable reference load, not the per-run
  // fixture clone. A case is a durable statement about a kind of load; pinning
  // it to one run's ephemeral row would mean that row could never be cleaned
  // up, because eval_cases.load_id would still reference it.
  const [referenceLoad] = await db
    .select({ loadId: loads.loadId })
    .from(loads)
    .where(eq(loads.loadId, REFERENCE_LOAD_ID));

  await db.insert(evalCases).values({
    caseId: testCase.caseId,
    name: testCase.name,
    persona: testCase.personaId,
    loadId: referenceLoad?.loadId ?? loadId,
    expected: testCase.expected as unknown as Record<string, unknown>,
  }).onConflictDoNothing();

  await db.insert(evalResults).values({
    id: randomUUID(),
    runId,
    caseId: testCase.caseId,
    negotiationId,
    passed: result.passed,
    metrics: {
      outcome: result.outcome,
      turns: result.turns,
      policy_violations: result.policyViolations,
      tool_call_score: result.toolCallScore,
      tool_call_recall: tools.recall,
      tool_call_precision: tools.precision,
      // Attempted and refused. Not a failure, but worth seeing.
      forbidden_attempted: tools.forbiddenAttempted,
      failures,
      model: agent.model,
    },
  });

  return result;
}

export interface SuiteResult {
  readonly runId: string;
  readonly results: readonly CaseResult[];
  readonly passed: number;
  readonly failed: number;
  /** Cases that could not be run at all. Not counted as agent failures. */
  readonly errored: number;
  readonly totalViolations: number;
  readonly meanToolCallScore: number;
}

export async function runSuite(
  db: Database,
  cases: readonly EvalCase[],
  agent: LlmProvider,
  simulation: LlmProvider | undefined,
  suiteName: string,
): Promise<SuiteResult> {
  const runId = randomUUID();
  await db.insert(evalRuns).values({
    id: runId,
    gitSha: gitSha(),
    suite: suiteName,
    provider: agent.name,
    model: agent.model,
    modelVersion: null,
    promptVersion: PROMPT_VERSION,
  });

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    try {
      results.push(await runCase(db, runId, testCase, agent, simulation));
    } catch (error) {
      // One case blowing up must not discard the cases that already ran. A
      // suite costs real quota and minutes, and losing four completed results
      // to a dropped connection on the fifth is the wrong trade.
      //
      // Recorded as an error rather than a failure: "the harness could not run
      // this" is a different claim from "the agent got this wrong", and
      // collapsing the two would quietly turn infrastructure trouble into an
      // agent regression.
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        caseId: testCase.caseId,
        negotiationId: "",
        outcome: "ERROR",
        turns: 0,
        passed: false,
        failures: [`could not run: ${message}`],
        policyViolations: 0,
        toolCallScore: 0,
        model: agent.model,
        error: message,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const errored = results.filter((r) => r.error !== undefined).length;
  const totalViolations = results.reduce((a, r) => a + r.policyViolations, 0);

  // Scored over cases that actually ran. Averaging a zero in for a case that
  // never executed would report an agent regression where there was a network
  // problem.
  const scored = results.filter((r) => r.error === undefined);
  const meanToolCallScore =
    scored.length === 0 ? 0 : scored.reduce((a, r) => a + r.toolCallScore, 0) / scored.length;

  await db.update(evalRuns)
    .set({
      finishedAt: new Date(),
      metrics: {
        cases: results.length,
        passed,
        failed: results.length - passed - errored,
        errored,
        policy_violations: totalViolations,
        mean_tool_call_score: meanToolCallScore,
      },
    })
    .where(eq(evalRuns.id, runId));

  return {
    runId,
    results,
    passed,
    failed: results.length - passed - errored,
    errored,
    totalViolations,
    meanToolCallScore,
  };
}
