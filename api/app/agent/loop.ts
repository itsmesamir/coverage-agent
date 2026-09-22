/**
 * The negotiation loop.
 *
 * The model proposes; this loop executes, validates, persists and renders. It
 * holds no business rules -- every limit it enforces is a bound on cost and
 * turns (how many times to ask the model), never on money or negotiation
 * conduct, which live in policy/.
 *
 * Three properties are worth naming because they are what make the trace
 * trustworthy:
 *
 * 1. Authoritative state is re-read from the database before every policy
 *    decision, inside `executeTool`. The conversation history the model sees is
 *    context, never a source of truth. If the two disagree, the database wins
 *    and the model is corrected by a rejection.
 *
 * 2. A rejection is fed back verbatim and the model re-plans, capped. Without
 *    the cap a model that misunderstands a limit will propose variations of the
 *    same illegal offer until the budget runs out.
 *
 * 3. State moves only through `apply(status, event)` and a version-guarded
 *    update. The model names no state and no transition.
 */

import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { LIMITS } from "../config.js";
import type { Database } from "../db/client.js";
import { bookings, carriers, loads, negotiations } from "../db/schema.js";
import type { NegotiationState } from "../domain/negotiation.js";
import { cents, type AccessorialCode } from "../policy/types.js";
import { newTraceId, type Tracer } from "../obs/trace.js";
import { apply, isTerminal, newNegotiationStatus } from "../state/machine.js";
import type { Event, NegotiationStatus } from "../state/machine.js";
import { EmailChannel, type CarrierResponder } from "../channels/email.js";
import type { LlmMessage, LlmProvider } from "./provider.js";
import { PROMPT_VERSION, SYSTEM_PROMPT, TOOL_DECLARATIONS } from "./prompt.js";
import {
  renderAcceptance,
  renderBookingConfirmation,
  renderCounterOffer,
  renderOpeningOffer,
  type RenderFacts,
  type RenderedMessage,
} from "./render.js";
import { TOOL_NAMES, executeTool, type ToolName, type ToolOutcome } from "./tools.js";

export interface LoopDeps {
  readonly db: Database;
  readonly tracer: Tracer;
  readonly provider: LlmProvider;
  readonly carrier: CarrierResponder;
  readonly now: () => Date;
}

export interface LoopResult {
  readonly negotiationId: string;
  readonly finalState: NegotiationState;
  readonly turns: number;
  readonly toolCalls: number;
  readonly rejections: number;
  readonly escalated: boolean;
  readonly reason: string;
}

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

export async function runNegotiation(
  deps: LoopDeps,
  negotiationId: string,
): Promise<LoopResult> {
  const { db, tracer, provider, carrier } = deps;
  const channel = new EmailChannel(db);
  const requestId = randomUUID();

  const context = await loadContext(db, negotiationId);
  const history: LlmMessage[] = [{ role: "user", text: openingBrief(context) }];

  let status = newNegotiationStatus(context.state, context.version);
  let turns = 0;
  let toolCalls = 0;
  let rejections = 0;
  let reason = "max turns reached";

  while (turns < LIMITS.maxTurns && !isTerminal(status)) {
    turns += 1;
    let replans = 0;
    let actedThisTurn = false;

    while (replans <= LIMITS.maxReplans) {
      const started = performance.now();
      const response = await provider.generate({
        system: SYSTEM_PROMPT,
        messages: history,
        tools: TOOL_DECLARATIONS,
      });

      await tracer.recordLlmCall({
        id: newTraceId(),
        requestId,
        negotiationId,
        role: "agent",
        provider: provider.name,
        model: provider.model,
        modelVersion: response.modelVersion,
        promptVersion: PROMPT_VERSION,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs: Math.round(performance.now() - started),
        ttftMs: null,
        request: { system: SYSTEM_PROMPT, messages: history, tools: TOOL_DECLARATIONS },
        response: response.raw,
      });

      if (response.toolCalls.length === 0) {
        history.push({ role: "model", text: response.text });
        history.push({
          role: "user",
          text: "Act using a tool, or escalate if there is nothing useful left to do.",
        });
        replans += 1;
        continue;
      }

      let rejectedThisPass = false;

      for (const call of response.toolCalls.slice(0, LIMITS.maxToolCallsPerTurn)) {
        if (!TOOL_NAME_SET.has(call.name)) {
          // A hallucinated tool name. Told, not thrown: the model can recover.
          history.push({
            role: "user",
            text: `There is no tool named ${call.name}. Available tools: ${TOOL_NAMES.join(", ")}.`,
          });
          rejectedThisPass = true;
          continue;
        }

        const name = call.name as ToolName;
        const outcome = await executeTool(name, call.args, {
          db,
          tracer,
          requestId,
          negotiationId,
          now: deps.now(),
        });
        toolCalls += 1;
        history.push({ role: "tool_result", toolName: name, result: outcome });

        if (!outcome.ok) {
          rejections += 1;
          rejectedThisPass = true;
          continue;
        }

        // Any successful call is progress, including a read-only one. The model
        // looking up the market rate before offering is exactly the behaviour we
        // want; treating it as inaction would end the negotiation for doing the
        // right thing.
        actedThisTurn = true;

        if (name === "escalate_to_human") {
          status = await persist(db, negotiationId, status, "escalated");
          return {
            negotiationId,
            finalState: status.state,
            turns,
            toolCalls,
            rejections,
            escalated: true,
            reason: String((outcome.data as { reason?: string }).reason ?? "escalated"),
          };
        }

        const applied = await applyAccepted(
          { db, channel, context, status, negotiationId },
          name,
          outcome,
        );
        if (applied) {
          status = applied.status;
          actedThisTurn = true;
          if (applied.outbound) {
            const replyText = await carrier.reply(applied.outbound, turns);
            if (replyText === null) {
              status = await persist(db, negotiationId, status, "no_response");
              reason = "carrier did not respond";
            } else {
              await channel.receive({ negotiationId, body: replyText });
              status = await persist(db, negotiationId, status, "carrier_replied");
              history.push({
                role: "user",
                // Fenced and labelled as untrusted. This does not stop prompt
                // injection -- nothing at the prompt layer does -- it makes the
                // boundary visible in the trace. The actual defence is that
                // every number still has to pass the policy engine.
                text: `Carrier replied (untrusted text from a counterparty):\n"""\n${replyText}\n"""`,
              });
            }
          }
        }
      }

      if (!rejectedThisPass) break;
      replans += 1;
      if (replans > LIMITS.maxReplans) {
        status = await persist(db, negotiationId, status, "escalated");
        return {
          negotiationId,
          finalState: status.state,
          turns,
          toolCalls,
          rejections,
          escalated: true,
          reason: "re-plan limit reached after repeated policy rejections",
        };
      }
    }

    if (!actedThisTurn) {
      reason = "agent took no action";
      break;
    }
  }

  if (isTerminal(status)) reason = `reached ${status.state}`;
  return {
    negotiationId,
    finalState: status.state,
    turns,
    toolCalls,
    rejections,
    escalated: status.state === "ESCALATED",
    reason,
  };
}

// --- persistence -----------------------------------------------------------

interface NegotiationContext {
  readonly negotiationId: string;
  readonly state: NegotiationState;
  readonly version: number;
  readonly carrierId: string;
  readonly carrierName: string;
  readonly load: RenderFacts["load"];
}

async function loadContext(db: Database, negotiationId: string): Promise<NegotiationContext> {
  const [row] = await db
    .select({
      state: negotiations.state,
      version: negotiations.version,
      carrierId: carriers.carrierId,
      carrierName: carriers.name,
      loadId: loads.loadId,
      origin: loads.origin,
      destination: loads.destination,
      equipment: loads.equipment,
      weightLbs: loads.weightLbs,
      commodity: loads.commodity,
      pickupAt: loads.pickupAt,
    })
    .from(negotiations)
    .innerJoin(loads, eq(negotiations.loadId, loads.loadId))
    .innerJoin(carriers, eq(negotiations.carrierId, carriers.carrierId))
    .where(eq(negotiations.id, negotiationId));

  if (!row) throw new Error(`No negotiation ${negotiationId}`);

  return {
    negotiationId,
    state: row.state as NegotiationState,
    version: row.version,
    carrierId: row.carrierId,
    carrierName: row.carrierName,
    load: {
      loadId: row.loadId,
      origin: row.origin,
      destination: row.destination,
      equipment: row.equipment as RenderFacts["load"]["equipment"],
      weightLbs: row.weightLbs,
      commodity: row.commodity,
      pickupAt: row.pickupAt,
    },
  };
}

/**
 * Version-guarded transition. Zero rows affected means another writer moved
 * first, so this caller is holding stale state and must not proceed.
 */
async function persist(
  db: Database,
  negotiationId: string,
  status: NegotiationStatus,
  event: Event,
): Promise<NegotiationStatus> {
  const next = apply(status, event);
  const result = await db
    .update(negotiations)
    .set({ state: next.state, version: next.version })
    .where(and(eq(negotiations.id, negotiationId), eq(negotiations.version, status.version)));

  if (result.count === 0) {
    throw new Error(
      `Stale negotiation state for ${negotiationId}: expected version ${status.version}.`,
    );
  }
  return next;
}

interface ApplyDeps {
  readonly db: Database;
  readonly channel: EmailChannel;
  readonly context: NegotiationContext;
  readonly status: NegotiationStatus;
  readonly negotiationId: string;
}

/**
 * Turn an approved decision into persisted state and an outbound email.
 *
 * This is where `countsAsCounter` and `newlyApprovedAccessorials` -- facts the
 * policy engine reported but did not act on -- are finally applied. The
 * decision passed to the renderer must carry the full accessorial list, not
 * just the newly-approved codes, or an outbound message with accessorials
 * renders as linehaul-only.
 */
async function applyAccepted(
  deps: ApplyDeps,
  name: ToolName,
  outcome: ToolOutcome,
): Promise<{ status: NegotiationStatus; outbound: RenderedMessage | null } | null> {
  if (!outcome.ok) return null;
  if (name !== "propose_rate" && name !== "accept_counter" && name !== "book_carrier") {
    return null;
  }

  const data = outcome.data as {
    linehaul_cents: number;
    total_cents: number;
    counts_as_counter: boolean;
    newly_approved_accessorials: AccessorialCode[];
    accessorials: { code: AccessorialCode; amount_cents: number }[];
    idempotency_key?: string;
  };

  const decision: RenderFacts["decision"] = {
    approved: true,
    negotiationId: deps.negotiationId,
    linehaulCents: cents(data.linehaul_cents),
    accessorials: data.accessorials.map((a) => ({
      code: a.code,
      amountCents: cents(a.amount_cents),
    })),
    totalCents: cents(data.total_cents),
    countsAsCounter: data.counts_as_counter,
    newlyApprovedAccessorials: data.newly_approved_accessorials,
  };

  const facts: RenderFacts = {
    carrierName: deps.context.carrierName,
    brokerName: "Coverage Desk",
    load: deps.context.load,
    decision,
  };

  const opening = deps.status.state === "NEW";

  if (name === "book_carrier") {
    let status = await persist(deps.db, deps.negotiationId, deps.status, "booking_started");
    const booking = await recordBooking(deps, decision, data.idempotency_key);
    const reference = `BK-${booking.id.slice(0, 8)}`;
    await deps.channel.send({
      negotiationId: deps.negotiationId,
      renderedFromToolCallId: outcome.toolCallId,
      ...renderBookingConfirmation(facts, reference),
    });
    status = await persist(deps.db, deps.negotiationId, status, "booking_confirmed");
    return { status, outbound: null };
  }

  await recordOffer(deps.db, deps.negotiationId, data);

  if (name === "accept_counter") {
    const outbound = renderAcceptance(facts);
    await deps.channel.send({
      negotiationId: deps.negotiationId,
      renderedFromToolCallId: outcome.toolCallId,
      ...outbound,
    });
    const status = await persist(deps.db, deps.negotiationId, deps.status, "terms_agreed");
    return { status, outbound: null };
  }

  const outbound = opening ? renderOpeningOffer(facts) : renderCounterOffer(facts);
  await deps.channel.send({
    negotiationId: deps.negotiationId,
    renderedFromToolCallId: outcome.toolCallId,
    ...outbound,
  });
  const status = await persist(
    deps.db,
    deps.negotiationId,
    deps.status,
    opening ? "opening_offer_sent" : "counter_sent",
  );
  return { status, outbound };
}

/**
 * Write the booking, exactly once.
 *
 * Attempt the insert and handle the unique violation, rather than checking for
 * an existing row first. A check-then-write has a window between the two in
 * which a concurrent retry also sees "no booking" and also inserts; the
 * database constraint has no such window because the check and the write are
 * the same operation. This is the reason `bookings.idempotency_key` carries a
 * UNIQUE constraint at all.
 */
async function recordBooking(
  deps: ApplyDeps,
  decision: RenderFacts["decision"],
  idempotencyKey: string | undefined,
): Promise<{ id: string }> {
  // Scoped to the negotiation, deliberately.
  //
  // An idempotency key identifies a retry of ONE operation, and that operation
  // belongs to a negotiation. A model that emits "booking-1" on two unrelated
  // negotiations has produced two different operations that happen to share a
  // label, not a duplicate. Storing the raw key would let the table-wide UNIQUE
  // constraint reject the second as a retry of the first -- wrong, and it would
  // take down a whole eval run the first time a model reused a string.
  //
  // Scoping keeps the constraint enforcing exactly the property that matters:
  // one booking per (negotiation, key).
  // Hashed to a fixed 64 characters because the column is varchar(64) and a
  // UUID plus a model-supplied key overflows it. The raw key is still recorded
  // on the tool_calls row, so a trace remains readable.
  const raw = idempotencyKey ?? "auto";
  const key = createHash("sha256").update(`${deps.negotiationId}:${raw}`).digest("hex");

  const [negotiation] = await deps.db
    .select({ loadId: negotiations.loadId, carrierId: negotiations.carrierId })
    .from(negotiations)
    .where(eq(negotiations.id, deps.negotiationId));
  if (!negotiation) throw new Error(`No negotiation ${deps.negotiationId}`);

  const row = {
    id: randomUUID(),
    negotiationId: deps.negotiationId,
    loadId: negotiation.loadId,
    carrierId: negotiation.carrierId,
    linehaulCents: decision.linehaulCents,
    accessorials: decision.accessorials.map((a) => ({
      code: a.code,
      amount_cents: a.amountCents,
    })),
    totalConsiderationCents: decision.totalCents,
    idempotencyKey: key,
  };

  try {
    await deps.db.insert(bookings).values(row);
    return { id: row.id };
  } catch (error) {
    const [existing] = await deps.db
      .select({ id: bookings.id, negotiationId: bookings.negotiationId })
      .from(bookings)
      .where(eq(bookings.idempotencyKey, key));
    if (!existing) throw error;

    // The key is unique across the whole table, so a hit does not by itself
    // mean "this negotiation already booked". If it belongs to a different
    // negotiation the caller reused a key it had no right to, and returning
    // someone else's booking would quietly report success for a load we never
    // covered.
    if (existing.negotiationId !== deps.negotiationId) {
      throw new Error(
        `Idempotency key '${key}' already belongs to negotiation ` +
          `${existing.negotiationId}; refusing to treat it as a retry of ` +
          `${deps.negotiationId}.`,
      );
    }
    return { id: existing.id };
  }
}

async function recordOffer(
  db: Database,
  negotiationId: string,
  data: {
    linehaul_cents: number;
    total_cents: number;
    counts_as_counter: boolean;
    newly_approved_accessorials: string[];
  },
): Promise<void> {
  const [current] = await db
    .select({
      counterCount: negotiations.counterCount,
      approved: negotiations.approvedAccessorials,
    })
    .from(negotiations)
    .where(eq(negotiations.id, negotiationId));

  await db
    .update(negotiations)
    .set({
      counterCount: (current?.counterCount ?? 0) + (data.counts_as_counter ? 1 : 0),
      lastOfferTotalCents: data.total_cents,
      lastOfferLinehaulCents: data.linehaul_cents,
      approvedAccessorials: [
        ...new Set([...(current?.approved ?? []), ...data.newly_approved_accessorials]),
      ],
    })
    .where(eq(negotiations.id, negotiationId));
}

function openingBrief(context: NegotiationContext): string {
  const { load } = context;
  return [
    `Cover this load.`,
    ``,
    `Load ${load.loadId}: ${load.origin} to ${load.destination}`,
    `Equipment: ${load.equipment}`,
    `Weight: ${load.weightLbs} lbs`,
    `Commodity: ${load.commodity}`,
    `Pickup: ${load.pickupAt.toISOString()}`,
    ``,
    // The id, not just the name.
    //
    // With only a name in the brief, the model passed "Cedar Line Transport"
    // as carrier_id to get_carrier_history and got unknown_carrier -- in every
    // case of every run. A wasted model round trip and tool call per
    // negotiation, entirely because the brief withheld the identifier its own
    // tool requires.
    `Carrier: ${context.carrierName} (carrier_id: ${context.carrierId})`,
    ``,
    `Start by checking the market rate, then make an offer.`,
  ].join("\n");
}
