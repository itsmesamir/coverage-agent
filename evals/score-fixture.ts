/**
 * Score a trace fixture. Pure: a corpus in, metrics out. No database, no model.
 *
 * This is what CI runs, and it is deliberately the same metric code the live
 * harness runs -- a regression check that scored traces differently from the
 * developer's own tooling would be measuring a third thing nobody looks at.
 */

import { scorePolicy, type TracedDecision, type Violation } from "./metrics/policy.js";
import { scoreToolCalls } from "./metrics/tool-calls.js";
import { scoreHallucination, type GroundTruth } from "./metrics/hallucination.js";
import type { FixtureTrace, TraceFixture } from "./fixtures.js";

const MUTATING = new Set(["propose_rate", "accept_counter", "book_carrier"]);

interface AcceptedData {
  readonly linehaul_cents?: number;
  readonly total_cents?: number;
  readonly counts_as_counter?: boolean;
  readonly accessorials?: readonly { code?: string }[];
}

export function decisionsOf(trace: FixtureTrace): TracedDecision[] {
  const out: TracedDecision[] = [];
  for (const call of trace.toolCalls) {
    if (call.policyResult !== "accepted" || !MUTATING.has(call.toolName)) continue;
    const data = (call.result as { data?: AcceptedData } | null)?.data;
    if (!data || data.total_cents === undefined || data.linehaul_cents === undefined) continue;
    out.push({
      toolCallId: call.id,
      toolName: call.toolName,
      linehaulCents: data.linehaul_cents,
      totalCents: data.total_cents,
      accessorialCodes: (data.accessorials ?? [])
        .map((a) => a.code)
        .filter((c): c is string => typeof c === "string"),
      countsAsCounter: data.counts_as_counter === true,
    });
  }
  return out;
}

export interface FixtureScore {
  readonly traces: number;
  readonly decisionsChecked: number;
  readonly policyViolations: number;
  readonly violations: readonly (Violation & { negotiationId: string })[];
  /** Mean over traces that made at least one tool call. */
  readonly meanToolCallScore: number;
  readonly toolCallsScored: number;
  readonly hallucinationRate: number;
  readonly claimsSettleable: number;
  readonly claimsAmbiguous: number;
  readonly messagesWithClaims: number;
}

export function scoreFixture(fixture: TraceFixture): FixtureScore {
  const violations: (Violation & { negotiationId: string })[] = [];
  let decisionsChecked = 0;
  let toolScoreTotal = 0;
  let toolCallsScored = 0;
  let supported = 0;
  let unsupported = 0;
  let ambiguous = 0;
  let messagesWithClaims = 0;

  for (const trace of fixture.traces) {
    const decisions = decisionsOf(trace);
    const policy = scorePolicy({
      load: {
        loadId: trace.load.loadId,
        maxCarrierPayCents: trace.load.maxCarrierPayCents,
        floorCents: trace.load.floorCents,
      },
      decisions,
      bookings: trace.bookings.map((b) => ({
        linehaulCents: b.linehaulCents,
        totalConsiderationCents: b.totalConsiderationCents,
      })),
      reachedAgreement: ["AGREED", "BOOKING", "BOOKED"].includes(trace.finalState),
    });
    decisionsChecked += policy.decisionsChecked;
    for (const v of policy.violations) {
      violations.push({ ...v, negotiationId: trace.negotiationId });
    }

    // Scored against the weakest expectation that is true of every case: the
    // agent must have offered something, and nothing may have been booked or
    // accepted before an offer stood. Per-case expectations live with the
    // cases; a fixture has no way to know which case produced a trace.
    if (trace.toolCalls.length > 0) {
      const tools = scoreToolCalls(
        trace.toolCalls.map((c) => ({ toolName: c.toolName, policyResult: c.policyResult })),
        { requiredTools: [] },
      );
      toolScoreTotal += tools.score;
      toolCallsScored += 1;
    }

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
      pickupAt: new Date(trace.load.pickupAt),
      carrierName: trace.carrierName,
      approvedAmountsCents: [...approved],
    };

    for (const message of trace.outbound) {
      if (message.extractedWith === null) continue;
      messagesWithClaims += 1;
      const score = scoreHallucination(message.claims, truth);
      supported += score.supported;
      unsupported += score.unsupported;
      ambiguous += score.ambiguous;
    }
  }

  const settleable = supported + unsupported;
  return {
    traces: fixture.traces.length,
    decisionsChecked,
    policyViolations: violations.length,
    violations,
    meanToolCallScore: toolCallsScored === 0 ? 0 : toolScoreTotal / toolCallsScored,
    toolCallsScored,
    hallucinationRate: settleable === 0 ? 0 : unsupported / settleable,
    claimsSettleable: settleable,
    claimsAmbiguous: ambiguous,
    messagesWithClaims,
  };
}
