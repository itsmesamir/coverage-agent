/**
 * Read a stored negotiation back out of the database and score it, with no
 * model calls at all.
 *
 * This is the reason invariant 5 exists. Iterating on a metric definition
 * against a corpus of stored traces costs nothing, so a metric can be argued
 * about, rewritten, and re-run a hundred times without spending a request. It
 * also means a trace captured months ago can be re-scored by today's metric,
 * which is what makes a baseline comparable over time rather than only against
 * the run that produced it.
 *
 * Nothing here re-executes the agent. It reads what happened.
 */

import { asc, eq, inArray } from "drizzle-orm";

import type { Database } from "../api/app/db/client.js";
import { bookings, loads, messages, negotiations, toolCalls } from "../api/app/db/schema.js";
import { scorePolicy, type PolicyScore, type TracedDecision } from "./metrics/policy.js";

/** A negotiation as stored, with everything a metric needs to score it. */
export interface StoredTrace {
  readonly negotiationId: string;
  readonly finalState: string;
  readonly load: {
    readonly loadId: string;
    readonly maxCarrierPayCents: number;
    readonly floorCents: number;
    readonly weightLbs: number;
    readonly commodity: string;
    readonly equipment: string;
    readonly origin: string;
    readonly destination: string;
    readonly pickupAt: Date;
  };
  readonly toolCalls: readonly StoredToolCall[];
  readonly outboundBodies: readonly string[];
  readonly bookings: readonly { linehaulCents: number; totalConsiderationCents: number }[];
}

export interface StoredToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly policyResult: string;
  readonly rejectionCode: string | null;
  readonly args: unknown;
  readonly result: unknown;
}

/** Shape of the `data` a successful mutating tool call recorded. */
interface AcceptedData {
  readonly linehaul_cents?: number;
  readonly total_cents?: number;
  readonly counts_as_counter?: boolean;
  readonly accessorials?: readonly { code?: string }[];
}

const MUTATING = new Set(["propose_rate", "accept_counter", "book_carrier"]);

export async function loadTrace(
  db: Database,
  negotiationId: string,
): Promise<StoredTrace | undefined> {
  const [row] = await db
    .select({
      negotiationId: negotiations.id,
      state: negotiations.state,
      loadId: loads.loadId,
      maxCarrierPayCents: loads.maxCarrierPayCents,
      floorCents: loads.floorCents,
      weightLbs: loads.weightLbs,
      commodity: loads.commodity,
      equipment: loads.equipment,
      origin: loads.origin,
      destination: loads.destination,
      pickupAt: loads.pickupAt,
    })
    .from(negotiations)
    .innerJoin(loads, eq(negotiations.loadId, loads.loadId))
    .where(eq(negotiations.id, negotiationId));

  if (!row) return undefined;

  const calls = await db
    .select({
      id: toolCalls.id,
      toolName: toolCalls.toolName,
      policyResult: toolCalls.policyResult,
      rejectionCode: toolCalls.rejectionCode,
      args: toolCalls.arguments,
      result: toolCalls.result,
    })
    .from(toolCalls)
    .where(eq(toolCalls.negotiationId, negotiationId))
    .orderBy(asc(toolCalls.createdAt));

  const outbound = await db
    .select({ body: messages.body, direction: messages.direction })
    .from(messages)
    .where(eq(messages.negotiationId, negotiationId))
    .orderBy(asc(messages.createdAt));

  const booked = await db
    .select({
      linehaulCents: bookings.linehaulCents,
      totalConsiderationCents: bookings.totalConsiderationCents,
    })
    .from(bookings)
    .where(eq(bookings.negotiationId, negotiationId));

  return {
    negotiationId: row.negotiationId,
    finalState: row.state,
    load: {
      loadId: row.loadId,
      maxCarrierPayCents: row.maxCarrierPayCents,
      floorCents: row.floorCents,
      weightLbs: row.weightLbs,
      commodity: row.commodity,
      equipment: row.equipment,
      origin: row.origin,
      destination: row.destination,
      pickupAt: row.pickupAt,
    },
    toolCalls: calls,
    outboundBodies: outbound.filter((m) => m.direction === "outbound").map((m) => m.body),
    bookings: booked,
  };
}

/** Every negotiation with at least one tool call, oldest first. */
export async function listTracedNegotiations(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: toolCalls.negotiationId })
    .from(toolCalls);
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}

export async function loadTraces(db: Database, ids: readonly string[]): Promise<StoredTrace[]> {
  if (ids.length === 0) return [];
  const found = await db
    .select({ id: negotiations.id })
    .from(negotiations)
    .where(inArray(negotiations.id, [...ids]));
  const traces: StoredTrace[] = [];
  for (const { id } of found) {
    const trace = await loadTrace(db, id);
    if (trace) traces.push(trace);
  }
  return traces;
}

/**
 * Pull the accepted mutating decisions out of a trace, in order.
 *
 * Only accepted calls: a rejected one changed nothing, and counting it as a
 * violation would mean the engine doing its job registered as the engine
 * failing.
 */
export function acceptedDecisions(trace: StoredTrace): TracedDecision[] {
  const out: TracedDecision[] = [];
  for (const call of trace.toolCalls) {
    if (call.policyResult !== "accepted" || !MUTATING.has(call.toolName)) continue;
    const result = call.result as { data?: AcceptedData } | null;
    const data = result?.data;
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

export function scoreTrace(trace: StoredTrace): PolicyScore {
  return scorePolicy({
    load: trace.load,
    decisions: acceptedDecisions(trace),
    bookings: trace.bookings,
    // A booking is only legitimate downstream of agreed terms. BOOKING and
    // BOOKED are both reachable only through AGREED, so either is evidence
    // agreement happened.
    reachedAgreement: ["AGREED", "BOOKING", "BOOKED"].includes(trace.finalState),
  });
}
