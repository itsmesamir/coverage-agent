/**
 * A trace corpus, exported to a file so CI can re-score it offline.
 *
 * The problem this solves: regression detection needs a fixed corpus, but the
 * traces live in a developer's database, and CI has neither that database nor
 * an API key nor the quota to generate fresh ones. Committing the corpus makes
 * the whole check deterministic, free, and runnable with no secrets.
 *
 * Extracted claims are cached alongside each message for the same reason.
 * Extraction is the one step that needs a model; verification against the load
 * record is pure. Caching the extraction means CI re-runs the VERIFICATION --
 * the part that encodes the judgement and the part most likely to be edited --
 * without calling anything. Re-extracting is a deliberate, occasional act,
 * not something a pull request pays for.
 */

import type { Claim } from "./metrics/hallucination.js";

export const FIXTURE_VERSION = 1;

export interface FixtureMessage {
  readonly messageId: string;
  readonly body: string;
  /** Claims extracted by a model, cached so verification runs without one. */
  readonly claims: readonly Claim[];
  /** Null when this message has never been through extraction. */
  readonly extractedWith: string | null;
}

export interface FixtureTrace {
  readonly negotiationId: string;
  readonly finalState: string;
  readonly carrierName: string;
  readonly load: {
    readonly loadId: string;
    readonly origin: string;
    readonly destination: string;
    readonly equipment: string;
    readonly weightLbs: number;
    readonly commodity: string;
    /** ISO 8601. Serialised as a string so the file round-trips exactly. */
    readonly pickupAt: string;
    readonly maxCarrierPayCents: number;
    readonly floorCents: number;
  };
  readonly toolCalls: readonly {
    readonly id: string;
    readonly toolName: string;
    readonly policyResult: string;
    readonly rejectionCode: string | null;
    readonly result: unknown;
  }[];
  readonly bookings: readonly {
    readonly linehaulCents: number;
    readonly totalConsiderationCents: number;
  }[];
  readonly outbound: readonly FixtureMessage[];
}

export interface TraceFixture {
  readonly version: number;
  /** When the corpus was captured, for the report. Not used in scoring. */
  readonly capturedAt: string;
  readonly gitSha: string;
  readonly traces: readonly FixtureTrace[];
}

export function fixtureStats(fixture: TraceFixture): {
  traces: number;
  toolCalls: number;
  messages: number;
  messagesWithClaims: number;
  outcomes: Record<string, number>;
} {
  const outcomes: Record<string, number> = {};
  let toolCalls = 0;
  let messages = 0;
  let messagesWithClaims = 0;

  for (const trace of fixture.traces) {
    outcomes[trace.finalState] = (outcomes[trace.finalState] ?? 0) + 1;
    toolCalls += trace.toolCalls.length;
    messages += trace.outbound.length;
    messagesWithClaims += trace.outbound.filter((m) => m.extractedWith !== null).length;
  }

  return { traces: fixture.traces.length, toolCalls, messages, messagesWithClaims, outcomes };
}
