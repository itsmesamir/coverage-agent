/**
 * Drizzle schema.
 *
 * Two requirements shape this beyond ordinary relational modelling:
 *
 * 1. `bookings.idempotency_key` carries a database-level UNIQUE constraint. An
 *    application-level check cannot prevent a double booking, because two
 *    concurrent requests both read "no existing booking" before either writes.
 *
 * 2. A negotiation trace must be reconstructable from the database alone, with
 *    no LLM calls. That is what makes `make eval-replay` free, and it is why
 *    raw arguments, results and responses are stored as JSONB rather than
 *    summarised.
 *
 * Money is integer cents. Percentages are integer basis points.
 *
 * Column names are snake_case; TypeScript field names are camelCase. Drizzle
 * maps between them.
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

/** bge-small-en-v1.5 */
export const EMBEDDING_DIM = 384;

export const NEGOTIATION_STATES = [
  "NEW",
  "CARRIER_CONTACTED",
  "WAITING_FOR_RESPONSE",
  "NEGOTIATING",
  "AGREED",
  "BOOKING",
  "BOOKED",
  "ESCALATED",
  "FAILED",
] as const;

const now = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const carriers = pgTable(
  "carriers",
  {
    carrierId: varchar("carrier_id", { length: 16 }).primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    mcNumber: varchar("mc_number", { length: 24 }).notNull().unique(),
    dotNumber: varchar("dot_number", { length: 24 }).notNull().unique(),
    authorityActive: boolean("authority_active").notNull(),
    equipment: varchar("equipment", { length: 24 }).array().notNull(),
    fleetSize: integer("fleet_size").notNull(),
    onTimeBps: integer("on_time_bps").notNull(),
    homeRegion: varchar("home_region", { length: 24 }).notNull(),

    // The text that gets embedded, kept so an embedding can be regenerated or
    // audited without reconstructing the profile string.
    profileText: text("profile_text"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),

    createdAt: now(),
  },
  (t) => [
    check("ck_carriers_on_time_bps", sql`${t.onTimeBps} between 0 and 10000`),
    check("ck_carriers_fleet_size", sql`${t.fleetSize} > 0`),
    // Retrieval filters hard on authority before ranking anything.
    index("ix_carriers_authority_active").on(t.authorityActive),
    // Array containment: "carriers that own a dry van". GIN is the index type
    // that can answer @> on an array; btree cannot.
    index("ix_carriers_equipment").using("gin", t.equipment),
  ],
);

export const carrierLanes = pgTable(
  "carrier_lanes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    carrierId: varchar("carrier_id", { length: 16 })
      .notNull()
      .references(() => carriers.carrierId, { onDelete: "cascade" }),
    origin: varchar("origin", { length: 64 }).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    equipment: varchar("equipment", { length: 24 }).notNull(),
    loadsRun: integer("loads_run").notNull(),
    lastRateCents: integer("last_rate_cents").notNull(),
    lastRunDaysAgo: integer("last_run_days_ago").notNull(),
  },
  (t) => [
    // One history row per carrier per directional lane per trailer type.
    unique("uq_carrier_lane").on(t.carrierId, t.origin, t.destination, t.equipment),
    // The reranker's hot path: "who has run this lane?"
    index("ix_carrier_lanes_lane").on(t.origin, t.destination),
  ],
);

export const loads = pgTable(
  "loads",
  {
    loadId: varchar("load_id", { length: 16 }).primaryKey(),
    origin: varchar("origin", { length: 64 }).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    equipment: varchar("equipment", { length: 24 }).notNull(),
    weightLbs: integer("weight_lbs").notNull(),
    commodity: varchar("commodity", { length: 64 }).notNull(),
    pickupAt: timestamp("pickup_at", { withTimezone: true }).notNull(),

    customerRateCents: integer("customer_rate_cents").notNull(),
    targetMarginBps: integer("target_margin_bps").notNull(),
    maxCarrierPayCents: integer("max_carrier_pay_cents").notNull(),
    floorCents: integer("floor_cents").notNull(),

    createdAt: now(),
  },
  (t) => [
    // The rate band is an invariant of the row, so the database enforces it.
    // A load whose floor exceeds its ceiling is not a load.
    check(
      "ck_loads_rate_band",
      sql`${t.floorCents} < ${t.maxCarrierPayCents} and ${t.maxCarrierPayCents} < ${t.customerRateCents}`,
    ),
    check("ck_loads_weight", sql`${t.weightLbs} > 0`),
  ],
);

export const negotiations = pgTable(
  "negotiations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    loadId: varchar("load_id", { length: 16 })
      .notNull()
      .references(() => loads.loadId),
    carrierId: varchar("carrier_id", { length: 16 })
      .notNull()
      .references(() => carriers.carrierId),
    state: varchar("state", { length: 24 }).notNull(),

    counterCount: integer("counter_count").notNull().default(0),
    // Highest total consideration we have offered this carrier. The ratchet
    // compares against this, and it never decreases.
    lastOfferTotalCents: integer("last_offer_total_cents"),
    // Linehaul of that offer. A counter is a move in *linehaul*, not in total,
    // which is how approving an accessorial ratchets without burning a counter.
    // The policy engine needs both bases; storing only the total would make the
    // counter rule unanswerable after a restart.
    lastOfferLinehaulCents: integer("last_offer_linehaul_cents"),
    // Accessorial codes already approved on this negotiation, for the approval cap.
    approvedAccessorials: varchar("approved_accessorials", { length: 24 })
      .array()
      .notNull()
      .default(sql`'{}'::varchar[]`),

    // Optimistic concurrency. A writer updates WHERE id = ? AND version = ?;
    // zero rows affected means someone else moved the negotiation first and
    // this writer is holding stale state.
    version: integer("version").notNull().default(1),

    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "ck_negotiations_state",
      sql.raw(
        `state in (${NEGOTIATION_STATES.map((s) => `'${s}'`).join(", ")})`,
      ),
    ),
    check("ck_negotiations_counter_count", sql`${t.counterCount} >= 0`),
    // One negotiation per load/carrier pair: contacting the same carrier twice
    // about the same load is a bug, not a feature.
    unique("uq_negotiation_load_carrier").on(t.loadId, t.carrierId),
    // "What is still open on this load?"
    index("ix_negotiations_load_state").on(t.loadId, t.state),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    negotiationId: varchar("negotiation_id", { length: 36 })
      .notNull()
      .references(() => negotiations.id, { onDelete: "cascade" }),
    direction: varchar("direction", { length: 8 }).notNull(),
    channel: varchar("channel", { length: 16 }).notNull().default("email"),
    body: text("body").notNull(),

    // Which validated decision produced this outbound body. Null for inbound.
    // This is the audit link behind invariant 2: every price in an outbound
    // message traces to a tool call the policy engine approved.
    renderedFromToolCallId: varchar("rendered_from_tool_call_id", { length: 36 }),

    createdAt: now(),
  },
  (t) => [
    check("ck_messages_direction", sql`${t.direction} in ('inbound', 'outbound')`),
    // Transcript replay is always "this negotiation, in order".
    index("ix_messages_negotiation_created").on(t.negotiationId, t.createdAt),
  ],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    negotiationId: varchar("negotiation_id", { length: 36 }).references(
      () => negotiations.id,
      { onDelete: "cascade" },
    ),
    requestId: varchar("request_id", { length: 36 }).notNull(),
    toolName: varchar("tool_name", { length: 32 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),

    arguments: jsonb("arguments").notNull(),
    result: jsonb("result"),

    policyResult: varchar("policy_result", { length: 16 }).notNull(),
    rejectionCode: varchar("rejection_code", { length: 48 }),
    rejectionReason: text("rejection_reason"),
    latencyMs: integer("latency_ms").notNull(),

    createdAt: now(),
  },
  (t) => [
    check(
      "ck_tool_calls_policy_result",
      sql`${t.policyResult} in ('accepted', 'rejected', 'not_applicable')`,
    ),
    index("ix_tool_calls_negotiation_created").on(t.negotiationId, t.createdAt),
    // Tool-call correctness metric scans by tool across a run.
    index("ix_tool_calls_tool_name").on(t.toolName),
    // Policy violation metric: "show me every rejection". Partial, because
    // rejections should be a small minority -- if that stops being true, the
    // thesis is in trouble.
    index("ix_tool_calls_rejected")
      .on(t.policyResult)
      .where(sql`${t.policyResult} = 'rejected'`),
  ],
);

/**
 * Not in CLAUDE.md's table list. Added because invariants 5 and 7 require
 * model, model version, prompt version, tokens and latency to be traceable,
 * and no listed table holds them.
 */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    negotiationId: varchar("negotiation_id", { length: 36 }).references(
      () => negotiations.id,
      { onDelete: "cascade" },
    ),
    requestId: varchar("request_id", { length: 36 }).notNull(),
    role: varchar("role", { length: 16 }).notNull().default("agent"),

    provider: varchar("provider", { length: 24 }).notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    modelVersion: varchar("model_version", { length: 64 }),
    promptVersion: varchar("prompt_version", { length: 32 }).notNull(),

    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    ttftMs: integer("ttft_ms"),

    // Raw, not summarised. Replay depends on it.
    request: jsonb("request").notNull(),
    response: jsonb("response"),

    createdAt: now(),
  },
  (t) => [index("ix_llm_calls_negotiation_created").on(t.negotiationId, t.createdAt)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    negotiationId: varchar("negotiation_id", { length: 36 })
      .notNull()
      .unique()
      .references(() => negotiations.id),
    loadId: varchar("load_id", { length: 16 })
      .notNull()
      .references(() => loads.loadId),
    carrierId: varchar("carrier_id", { length: 16 })
      .notNull()
      .references(() => carriers.carrierId),

    linehaulCents: integer("linehaul_cents").notNull(),
    accessorials: jsonb("accessorials").notNull().default([]),
    totalConsiderationCents: integer("total_consideration_cents").notNull(),

    // THE constraint. Enforced by the database because the database is the
    // only component that sees every concurrent writer.
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull().unique(),

    bookedAt: timestamp("booked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("ck_bookings_linehaul", sql`${t.linehaulCents} > 0`),
    check(
      "ck_bookings_total_ge_linehaul",
      sql`${t.totalConsiderationCents} >= ${t.linehaulCents}`,
    ),
    index("ix_bookings_load").on(t.loadId),
  ],
);

export const evalCases = pgTable("eval_cases", {
  caseId: varchar("case_id", { length: 48 }).primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  persona: varchar("persona", { length: 48 }).notNull(),
  loadId: varchar("load_id", { length: 16 })
    .notNull()
    .references(() => loads.loadId),
  expected: jsonb("expected").notNull(),
  createdAt: now(),
});

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    gitSha: varchar("git_sha", { length: 40 }).notNull(),
    suite: varchar("suite", { length: 24 }).notNull(),
    provider: varchar("provider", { length: 24 }).notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    modelVersion: varchar("model_version", { length: 64 }),
    promptVersion: varchar("prompt_version", { length: 32 }).notNull(),
    metrics: jsonb("metrics"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  // The dashboard's question: "how has this metric moved over time?"
  (t) => [index("ix_eval_runs_started").on(t.startedAt)],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    runId: varchar("run_id", { length: 36 })
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    caseId: varchar("case_id", { length: 48 })
      .notNull()
      .references(() => evalCases.caseId),
    negotiationId: varchar("negotiation_id", { length: 36 }).references(() => negotiations.id),
    passed: boolean("passed").notNull(),
    metrics: jsonb("metrics").notNull(),
    createdAt: now(),
  },
  (t) => [
    // A case appears at most once per run.
    unique("uq_eval_result_run_case").on(t.runId, t.caseId),
    index("ix_eval_results_run").on(t.runId),
  ],
);
