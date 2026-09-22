/**
 * The seven tools. Deliberately small, strictly typed, and the only surface the
 * model can act through.
 *
 * There is no `send_free_text`. See render.ts for the full argument; the short
 * version is that a tool taking a model-authored string and putting it in front
 * of a carrier would make every guarantee in this system advisory.
 *
 * Three read-only tools (`search_carriers`, `get_carrier_history`,
 * `get_market_rate`) need no policy check: they answer questions and change
 * nothing. Three mutating tools (`propose_rate`, `accept_counter`,
 * `book_carrier`) route through the policy engine and carry an idempotency key.
 * `escalate_to_human` is always permitted -- refusing to let the agent give up
 * would be the wrong failure mode.
 *
 * Arguments are parsed with zod before anything else happens. A model can and
 * will emit a string where a number belongs, a missing field, or an extra one;
 * that is a normal failure, not an exception, so it comes back as a structured
 * rejection the agent can re-plan on.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client.js";
import { carrierLanes, carriers, loads, negotiations } from "../db/schema.js";
import { EQUIPMENT_TYPES, type Equipment } from "../domain/equipment.js";
import { getMetro, laneMarketRateCents } from "../domain/geography.js";
import type { NegotiationState } from "../domain/negotiation.js";
import { evaluateProposal } from "../policy/engine.js";
import {
  ACCESSORIAL_CODES,
  acceptCounter,
  bookCarrier,
  cents,
  proposeRate,
  type Accessorial,
  type AccessorialCode,
  type NegotiationSnapshot,
  type PolicyResult,
  type Proposal,
} from "../policy/types.js";
import { newTraceId, type PolicyResultLabel, type Tracer } from "../obs/trace.js";
import { searchCarriers } from "../retrieval/search.js";

export const TOOL_NAMES = [
  "search_carriers",
  "get_carrier_history",
  "get_market_rate",
  "propose_rate",
  "accept_counter",
  "book_carrier",
  "escalate_to_human",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that change something. These validate twice and take an idempotency key. */
export const MUTATING_TOOLS: ReadonlySet<ToolName> = new Set([
  "propose_rate",
  "accept_counter",
  "book_carrier",
]);

const equipmentSchema = z.enum(EQUIPMENT_TYPES);
const accessorialSchema = z.object({
  code: z.enum(ACCESSORIAL_CODES),
  amount_cents: z.number().int().nonnegative(),
});

export const TOOL_SCHEMAS = {
  search_carriers: z.object({
    origin: z.string().min(1),
    destination: z.string().min(1),
    equipment: equipmentSchema,
    weight_lbs: z.number().int().positive(),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  get_carrier_history: z.object({
    carrier_id: z.string().min(1),
    origin: z.string().min(1).optional(),
    destination: z.string().min(1).optional(),
  }),
  get_market_rate: z.object({
    origin: z.string().min(1),
    destination: z.string().min(1),
    equipment: equipmentSchema,
  }),
  propose_rate: z.object({
    linehaul_cents: z.number().int(),
    accessorials: z.array(accessorialSchema).default([]),
    idempotency_key: z.string().min(1).max(64),
    reasoning: z.string().min(1).max(500),
  }),
  accept_counter: z.object({
    linehaul_cents: z.number().int(),
    accessorials: z.array(accessorialSchema).default([]),
    idempotency_key: z.string().min(1).max(64),
    reasoning: z.string().min(1).max(500),
  }),
  book_carrier: z.object({
    linehaul_cents: z.number().int(),
    accessorials: z.array(accessorialSchema).default([]),
    idempotency_key: z.string().min(1).max(64),
  }),
  escalate_to_human: z.object({
    reason: z.string().min(1).max(500),
  }),
} as const satisfies Record<ToolName, z.ZodTypeAny>;

/**
 * `reasoning` is captured for the trace and shown to no carrier. It is the
 * model explaining itself to the log, not to a counterparty -- which is why it
 * can be free text without weakening invariant 2.
 */
export interface ToolContext {
  readonly db: Database;
  readonly tracer: Tracer;
  readonly requestId: string;
  readonly negotiationId: string | null;
  readonly now: Date;
}

/** What a handler produces, before executeTool attaches which trace row recorded it. */
type RawOutcome =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly code: string;
      readonly explanation: string;
      readonly details?: Readonly<Record<string, number | string>>;
    };

/**
 * What executeTool returns. `toolCallId` on the success branch is the
 * tool_calls row this call wrote -- render.ts and the loop use it to link an
 * outbound message back to the exact approved decision that produced it.
 */
export type ToolOutcome =
  | { readonly ok: true; readonly data: unknown; readonly toolCallId: string }
  | {
      readonly ok: false;
      readonly code: string;
      readonly explanation: string;
      readonly details?: Readonly<Record<string, number | string>>;
    };

function failure(
  code: string,
  explanation: string,
  details: Readonly<Record<string, number | string>> = {},
): RawOutcome {
  return { ok: false, code, explanation, details };
}

function toAccessorials(input: readonly { code: string; amount_cents: number }[]): Accessorial[] {
  return input.map((a) => ({
    code: a.code as Accessorial["code"],
    amountCents: cents(a.amount_cents),
  }));
}

/**
 * Assemble the policy snapshot from persisted state.
 *
 * Nothing the model said reaches this function. The snapshot is read from the
 * database every time, so an agent cannot smuggle a higher ceiling or a lower
 * counter count into the decision by describing one.
 */
export async function loadSnapshot(
  db: Database,
  negotiationId: string,
): Promise<NegotiationSnapshot | undefined> {
  const [row] = await db
    .select({
      negotiationId: negotiations.id,
      state: negotiations.state,
      counterCount: negotiations.counterCount,
      lastOfferTotalCents: negotiations.lastOfferTotalCents,
      lastOfferLinehaulCents: negotiations.lastOfferLinehaulCents,
      approvedAccessorials: negotiations.approvedAccessorials,
      loadId: loads.loadId,
      equipment: loads.equipment,
      weightLbs: loads.weightLbs,
      maxCarrierPayCents: loads.maxCarrierPayCents,
      floorCents: loads.floorCents,
      carrierId: carriers.carrierId,
      carrierEquipment: carriers.equipment,
      authorityActive: carriers.authorityActive,
    })
    .from(negotiations)
    .innerJoin(loads, eq(negotiations.loadId, loads.loadId))
    .innerJoin(carriers, eq(negotiations.carrierId, carriers.carrierId))
    .where(eq(negotiations.id, negotiationId));

  if (!row) return undefined;

  return {
    negotiationId: row.negotiationId,
    state: row.state as NegotiationState,
    load: {
      loadId: row.loadId,
      equipment: row.equipment as Equipment,
      weightLbs: row.weightLbs,
      maxCarrierPayCents: cents(row.maxCarrierPayCents),
      floorCents: cents(row.floorCents),
    },
    carrier: {
      carrierId: row.carrierId,
      equipment: row.carrierEquipment as Equipment[],
      authorityActive: row.authorityActive,
      // Known gap: carriers has no expiry timestamp, only the active/inactive
      // flag, so mid-negotiation authority lapse can only be exercised today
      // by constructing a Carrier directly in a test. The policy rule and its
      // tests are real; the column to drive it from live data is not.
      authorityExpiresAt: null,
    },
    counterCount: row.counterCount,
    lastOfferTotalCents: row.lastOfferTotalCents === null ? null : cents(row.lastOfferTotalCents),
    lastOfferLinehaulCents:
      row.lastOfferLinehaulCents === null ? null : cents(row.lastOfferLinehaulCents),
    approvedAccessorials: new Set(row.approvedAccessorials as AccessorialCode[]),
  };
}

function policyLabel(result: PolicyResult | undefined): PolicyResultLabel {
  if (result === undefined) return "not_applicable";
  return result.approved ? "accepted" : "rejected";
}

/**
 * Execute one tool: parse, run, trace. Always traces, including on rejection --
 * a rejected call is the most interesting row in the table, because zero policy
 * violations is a claim that has to be checkable against what was attempted,
 * not only against what succeeded.
 */
export async function executeTool(
  name: ToolName,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const startedAt = performance.now();
  const traceId = newTraceId();
  let outcome: RawOutcome;
  let policyResult: PolicyResult | undefined;
  let idempotencyKey: string | null = null;

  const parsed = TOOL_SCHEMAS[name].safeParse(rawArgs);
  if (!parsed.success) {
    outcome = failure(
      "invalid_arguments",
      `Arguments for ${name} did not validate: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    );
  } else {
    const args = parsed.data as Record<string, unknown>;
    idempotencyKey = typeof args["idempotency_key"] === "string" ? args["idempotency_key"] : null;
    const run = await runTool(name, args, ctx);
    outcome = run.outcome;
    policyResult = run.policyResult;
  }

  await ctx.tracer.recordToolCall({
    id: traceId,
    requestId: ctx.requestId,
    negotiationId: ctx.negotiationId,
    toolName: name,
    idempotencyKey,
    arguments: rawArgs,
    result: outcome,
    policyResult: policyLabel(policyResult),
    rejectionCode: outcome.ok ? null : outcome.code,
    rejectionReason: outcome.ok ? null : outcome.explanation,
    latencyMs: Math.round(performance.now() - startedAt),
  });

  return outcome.ok ? { ...outcome, toolCallId: traceId } : outcome;
}

async function runTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ outcome: RawOutcome; policyResult?: PolicyResult }> {
  switch (name) {
    case "search_carriers":
      return { outcome: await doSearchCarriers(args, ctx) };
    case "get_carrier_history":
      return { outcome: await doCarrierHistory(args, ctx) };
    case "get_market_rate":
      return { outcome: doMarketRate(args) };
    case "propose_rate":
    case "accept_counter":
    case "book_carrier":
      return doMutating(name, args, ctx);
    case "escalate_to_human":
      return {
        outcome: { ok: true, data: { escalated: true, reason: args["reason"] as string } },
      };
  }
}

async function doSearchCarriers(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<RawOutcome> {
  const origin = args["origin"] as string;
  const destination = args["destination"] as string;
  const equipment = args["equipment"] as Equipment;
  const weightLbs = args["weight_lbs"] as number;
  const limit = args["limit"] as number;

  let marketRateCents: number;
  try {
    marketRateCents = laneMarketRateCents(getMetro(origin), getMetro(destination), equipment);
  } catch {
    return failure("unknown_lane", `No market data for ${origin} to ${destination}.`);
  }

  const result = await searchCarriers(
    ctx.db,
    { origin, destination, equipment, weightLbs, marketRateCents },
    50,
    limit,
  );

  return {
    ok: true,
    data: {
      carriers: result.ranked.map((r) => ({
        carrier_id: r.carrierId,
        score: Number(r.score.toFixed(4)),
        trailer: r.trailer,
      })),
      considered: result.candidates.length,
    },
  };
}

async function doCarrierHistory(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<RawOutcome> {
  const carrierId = args["carrier_id"] as string;
  const origin = args["origin"] as string | undefined;
  const destination = args["destination"] as string | undefined;

  const [carrier] = await ctx.db
    .select({
      carrierId: carriers.carrierId,
      name: carriers.name,
      onTimeBps: carriers.onTimeBps,
      fleetSize: carriers.fleetSize,
      authorityActive: carriers.authorityActive,
      equipment: carriers.equipment,
    })
    .from(carriers)
    .where(eq(carriers.carrierId, carrierId));

  if (!carrier) return failure("unknown_carrier", `No carrier ${carrierId}.`);

  const where =
    origin && destination
      ? and(
          eq(carrierLanes.carrierId, carrierId),
          eq(carrierLanes.origin, origin),
          eq(carrierLanes.destination, destination),
        )
      : eq(carrierLanes.carrierId, carrierId);

  const lanes = await ctx.db
    .select({
      origin: carrierLanes.origin,
      destination: carrierLanes.destination,
      loadsRun: carrierLanes.loadsRun,
      lastRateCents: carrierLanes.lastRateCents,
      lastRunDaysAgo: carrierLanes.lastRunDaysAgo,
    })
    .from(carrierLanes)
    .where(where);

  return {
    ok: true,
    data: {
      carrier_id: carrier.carrierId,
      name: carrier.name,
      on_time_bps: carrier.onTimeBps,
      fleet_size: carrier.fleetSize,
      authority_active: carrier.authorityActive,
      equipment: carrier.equipment,
      lanes: lanes.map((l) => ({
        origin: l.origin,
        destination: l.destination,
        loads_run: l.loadsRun,
        last_rate_cents: l.lastRateCents,
        last_run_days_ago: l.lastRunDaysAgo,
      })),
    },
  };
}

function doMarketRate(args: Record<string, unknown>): RawOutcome {
  const origin = args["origin"] as string;
  const destination = args["destination"] as string;
  const equipment = args["equipment"] as Equipment;
  try {
    const rate = laneMarketRateCents(getMetro(origin), getMetro(destination), equipment);
    return { ok: true, data: { origin, destination, equipment, market_rate_cents: rate } };
  } catch {
    return failure("unknown_lane", `No market data for ${origin} to ${destination}.`);
  }
}

function buildProposal(name: ToolName, args: Record<string, unknown>): Proposal {
  const linehaul = cents(args["linehaul_cents"] as number);
  const accessorials = toAccessorials(
    (args["accessorials"] ?? []) as { code: string; amount_cents: number }[],
  );
  if (name === "propose_rate") return proposeRate(linehaul, accessorials);
  if (name === "accept_counter") return acceptCounter(linehaul, accessorials);
  return bookCarrier(linehaul, args["idempotency_key"] as string, accessorials);
}

async function doMutating(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ outcome: RawOutcome; policyResult?: PolicyResult }> {
  if (!ctx.negotiationId) {
    return { outcome: failure("no_negotiation", `${name} requires a negotiation.`) };
  }

  const snapshot = await loadSnapshot(ctx.db, ctx.negotiationId);
  if (!snapshot) {
    return { outcome: failure("unknown_negotiation", `No negotiation ${ctx.negotiationId}.`) };
  }

  let proposal: Proposal;
  try {
    proposal = buildProposal(name, args);
  } catch (error) {
    // cents() throws on a non-integer, which is invariant 8 refusing a float.
    return {
      outcome: failure("invalid_amount", error instanceof Error ? error.message : String(error)),
    };
  }

  const result = evaluateProposal(snapshot, proposal, ctx.now);
  if (!result.approved) {
    return {
      outcome: failure(result.code, result.explanation, result.details),
      policyResult: result,
    };
  }

  return {
    outcome: {
      ok: true,
      data: {
        linehaul_cents: result.linehaulCents,
        total_cents: result.totalCents,
        counts_as_counter: result.countsAsCounter,
        newly_approved_accessorials: result.newlyApprovedAccessorials,
        // The full line-item list, not just the codes newly approved this
        // call -- the renderer needs every accessorial on the decision to
        // itemize an outbound message, not only what changed this turn.
        accessorials: result.accessorials.map((a) => ({
          code: a.code,
          amount_cents: a.amountCents,
        })),
        // Carried through so the loop can write the booking row under the same
        // key the model supplied -- the database UNIQUE constraint on it is
        // what makes a retry idempotent rather than a second booking.
        idempotency_key: args["idempotency_key"] as string,
      },
    },
    policyResult: result,
  };
}
