-- HAND-ADDED, and must survive any regeneration of this file.
-- drizzle-kit has no concept of Postgres extensions, so it emits the
-- vector(384) column on carriers without ever creating the type. On a clean
-- database the generated SQL alone fails with: type "vector" does not exist.
-- Kept in the versioned migration rather than typed into psql once, so a
-- fresh clone reaches the same schema by running one command.
-- api/tests/integration/db-schema.test.ts asserts this line is still here,
-- because `pnpm run db:generate` would silently drop it.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"negotiation_id" varchar(36) NOT NULL,
	"load_id" varchar(16) NOT NULL,
	"carrier_id" varchar(16) NOT NULL,
	"linehaul_cents" integer NOT NULL,
	"accessorials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_consideration_cents" integer NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_negotiation_id_unique" UNIQUE("negotiation_id"),
	CONSTRAINT "bookings_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ck_bookings_linehaul" CHECK ("bookings"."linehaul_cents" > 0),
	CONSTRAINT "ck_bookings_total_ge_linehaul" CHECK ("bookings"."total_consideration_cents" >= "bookings"."linehaul_cents")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "carrier_lanes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"carrier_id" varchar(16) NOT NULL,
	"origin" varchar(64) NOT NULL,
	"destination" varchar(64) NOT NULL,
	"equipment" varchar(24) NOT NULL,
	"loads_run" integer NOT NULL,
	"last_rate_cents" integer NOT NULL,
	"last_run_days_ago" integer NOT NULL,
	CONSTRAINT "uq_carrier_lane" UNIQUE("carrier_id","origin","destination","equipment")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "carriers" (
	"carrier_id" varchar(16) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"mc_number" varchar(24) NOT NULL,
	"dot_number" varchar(24) NOT NULL,
	"authority_active" boolean NOT NULL,
	"equipment" varchar(24)[] NOT NULL,
	"fleet_size" integer NOT NULL,
	"on_time_bps" integer NOT NULL,
	"home_region" varchar(24) NOT NULL,
	"profile_text" text,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carriers_mc_number_unique" UNIQUE("mc_number"),
	CONSTRAINT "carriers_dot_number_unique" UNIQUE("dot_number"),
	CONSTRAINT "ck_carriers_on_time_bps" CHECK ("carriers"."on_time_bps" between 0 and 10000),
	CONSTRAINT "ck_carriers_fleet_size" CHECK ("carriers"."fleet_size" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_cases" (
	"case_id" varchar(48) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"persona" varchar(48) NOT NULL,
	"load_id" varchar(16) NOT NULL,
	"expected" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_results" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"case_id" varchar(48) NOT NULL,
	"negotiation_id" varchar(36),
	"passed" boolean NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_eval_result_run_case" UNIQUE("run_id","case_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"git_sha" varchar(40) NOT NULL,
	"suite" varchar(24) NOT NULL,
	"provider" varchar(24) NOT NULL,
	"model" varchar(64) NOT NULL,
	"model_version" varchar(64),
	"prompt_version" varchar(32) NOT NULL,
	"metrics" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"negotiation_id" varchar(36),
	"request_id" varchar(36) NOT NULL,
	"role" varchar(16) DEFAULT 'agent' NOT NULL,
	"provider" varchar(24) NOT NULL,
	"model" varchar(64) NOT NULL,
	"model_version" varchar(64),
	"prompt_version" varchar(32) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"ttft_ms" integer,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loads" (
	"load_id" varchar(16) PRIMARY KEY NOT NULL,
	"origin" varchar(64) NOT NULL,
	"destination" varchar(64) NOT NULL,
	"equipment" varchar(24) NOT NULL,
	"weight_lbs" integer NOT NULL,
	"commodity" varchar(64) NOT NULL,
	"pickup_at" timestamp with time zone NOT NULL,
	"customer_rate_cents" integer NOT NULL,
	"target_margin_bps" integer NOT NULL,
	"max_carrier_pay_cents" integer NOT NULL,
	"floor_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_loads_rate_band" CHECK ("loads"."floor_cents" < "loads"."max_carrier_pay_cents" and "loads"."max_carrier_pay_cents" < "loads"."customer_rate_cents"),
	CONSTRAINT "ck_loads_weight" CHECK ("loads"."weight_lbs" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"negotiation_id" varchar(36) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"channel" varchar(16) DEFAULT 'email' NOT NULL,
	"body" text NOT NULL,
	"rendered_from_tool_call_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_messages_direction" CHECK ("messages"."direction" in ('inbound', 'outbound'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "negotiations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"load_id" varchar(16) NOT NULL,
	"carrier_id" varchar(16) NOT NULL,
	"state" varchar(24) NOT NULL,
	"counter_count" integer DEFAULT 0 NOT NULL,
	"last_offer_total_cents" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_negotiation_load_carrier" UNIQUE("load_id","carrier_id"),
	CONSTRAINT "ck_negotiations_state" CHECK (state in ('NEW', 'CARRIER_CONTACTED', 'WAITING_FOR_RESPONSE', 'NEGOTIATING', 'AGREED', 'BOOKING', 'BOOKED', 'ESCALATED', 'FAILED')),
	CONSTRAINT "ck_negotiations_counter_count" CHECK ("negotiations"."counter_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_calls" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"negotiation_id" varchar(36),
	"request_id" varchar(36) NOT NULL,
	"tool_name" varchar(32) NOT NULL,
	"idempotency_key" varchar(64),
	"arguments" jsonb NOT NULL,
	"result" jsonb,
	"policy_result" varchar(16) NOT NULL,
	"rejection_code" varchar(48),
	"rejection_reason" text,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tool_calls_policy_result" CHECK ("tool_calls"."policy_result" in ('accepted', 'rejected', 'not_applicable'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_load_id_loads_load_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("load_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_carrier_id_carriers_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("carrier_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "carrier_lanes" ADD CONSTRAINT "carrier_lanes_carrier_id_carriers_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("carrier_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_load_id_loads_load_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("load_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_eval_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("case_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_load_id_loads_load_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."loads"("load_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_carrier_id_carriers_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("carrier_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_bookings_load" ON "bookings" USING btree ("load_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_carrier_lanes_lane" ON "carrier_lanes" USING btree ("origin","destination");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_carriers_authority_active" ON "carriers" USING btree ("authority_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_carriers_equipment" ON "carriers" USING gin ("equipment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_eval_results_run" ON "eval_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_eval_runs_started" ON "eval_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_llm_calls_negotiation_created" ON "llm_calls" USING btree ("negotiation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_messages_negotiation_created" ON "messages" USING btree ("negotiation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_negotiations_load_state" ON "negotiations" USING btree ("load_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_tool_calls_negotiation_created" ON "tool_calls" USING btree ("negotiation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_tool_calls_tool_name" ON "tool_calls" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_tool_calls_rejected" ON "tool_calls" USING btree ("policy_result") WHERE "tool_calls"."policy_result" = 'rejected';