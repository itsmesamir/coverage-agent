/**
 * Tracing. Invariant 7: every tool call and every LLM call is recorded with
 * latency, arguments, result, policy outcome and rejection reason.
 *
 * Why this is an interface rather than a function that writes to the database:
 * invariant 5 says evals re-score stored traces with zero LLM calls, which
 * means the trace is the product, not a debugging aid. Tests need to assert on
 * what was recorded without a database, and the eval replay path needs to read
 * traces back. An interface with two implementations keeps both honest.
 *
 * Nothing here decides anything. A tracer that silently dropped writes would
 * break replay, so `DbTracer` lets write errors propagate rather than
 * swallowing them -- an untraced action is worse than a failed one.
 */

import { randomUUID } from "node:crypto";

import type { Database } from "../db/client.js";
import { llmCalls, toolCalls } from "../db/schema.js";

export const POLICY_RESULTS = ["accepted", "rejected", "not_applicable"] as const;
export type PolicyResultLabel = (typeof POLICY_RESULTS)[number];

export interface ToolCallTrace {
  readonly id: string;
  readonly requestId: string;
  readonly negotiationId: string | null;
  readonly toolName: string;
  readonly idempotencyKey: string | null;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly policyResult: PolicyResultLabel;
  readonly rejectionCode: string | null;
  readonly rejectionReason: string | null;
  readonly latencyMs: number;
}

export interface LlmCallTrace {
  readonly id: string;
  readonly requestId: string;
  readonly negotiationId: string | null;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly ttftMs: number | null;
  readonly request: unknown;
  readonly response: unknown;
}

export interface Tracer {
  recordToolCall(trace: ToolCallTrace): Promise<void>;
  recordLlmCall(trace: LlmCallTrace): Promise<void>;
}

export function newTraceId(): string {
  return randomUUID();
}

/** Writes traces to Postgres. Used in the application and in integration tests. */
export class DbTracer implements Tracer {
  constructor(private readonly db: Database) {}

  async recordToolCall(trace: ToolCallTrace): Promise<void> {
    await this.db.insert(toolCalls).values({
      id: trace.id,
      negotiationId: trace.negotiationId,
      requestId: trace.requestId,
      toolName: trace.toolName,
      idempotencyKey: trace.idempotencyKey,
      arguments: trace.arguments,
      result: trace.result,
      policyResult: trace.policyResult,
      rejectionCode: trace.rejectionCode,
      rejectionReason: trace.rejectionReason,
      latencyMs: trace.latencyMs,
    });
  }

  async recordLlmCall(trace: LlmCallTrace): Promise<void> {
    await this.db.insert(llmCalls).values({
      id: trace.id,
      negotiationId: trace.negotiationId,
      requestId: trace.requestId,
      role: trace.role,
      provider: trace.provider,
      model: trace.model,
      modelVersion: trace.modelVersion,
      promptVersion: trace.promptVersion,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      latencyMs: trace.latencyMs,
      ttftMs: trace.ttftMs,
      request: trace.request,
      response: trace.response,
    });
  }
}

/** Collects traces in memory. Used by unit tests and by the eval replay path. */
export class InMemoryTracer implements Tracer {
  readonly toolCalls: ToolCallTrace[] = [];
  readonly llmCalls: LlmCallTrace[] = [];

  async recordToolCall(trace: ToolCallTrace): Promise<void> {
    this.toolCalls.push(trace);
  }

  async recordLlmCall(trace: LlmCallTrace): Promise<void> {
    this.llmCalls.push(trace);
  }
}

/** Fans out to several tracers. Useful when a run should both persist and be asserted on. */
export class MultiTracer implements Tracer {
  constructor(private readonly tracers: readonly Tracer[]) {}

  async recordToolCall(trace: ToolCallTrace): Promise<void> {
    for (const tracer of this.tracers) await tracer.recordToolCall(trace);
  }

  async recordLlmCall(trace: LlmCallTrace): Promise<void> {
    for (const tracer of this.tracers) await tracer.recordLlmCall(trace);
  }
}
