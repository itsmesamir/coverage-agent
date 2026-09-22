/**
 * The migration applies to a clean database and the constraints it declares
 * are actually enforced.
 *
 * These hit a real Postgres. `make up` must be running.
 *
 * Note on isolation: bookings carries TWO unique constraints -- idempotency_key
 * and negotiation_id. A test that reuses one negotiation cannot tell which one
 * rejected an insert, so each test asserts the constraint name it expects, and
 * the idempotency tests spread across distinct negotiations so that
 * negotiation_id can never be the thing doing the work.
 */

import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createClient, createDb } from "../../app/db/client.js";
import { bookings, carriers, loads, negotiations } from "../../app/db/schema.js";

const MIGRATIONS_DIR = "api/app/db/migrations";

const client = createClient(undefined, 10);
const db = createDb(client);

const suffix = randomUUID().slice(0, 8);
const LOAD_ID = `T-${suffix.slice(0, 6)}`;
const CARRIER_ID = `TC-${suffix.slice(0, 6)}`;
const negotiationIds: string[] = [];

const carrierIds: string[] = [];
async function newCarrier(): Promise<string> {
  const id = `TC${randomUUID().slice(0, 10)}`;
  await db.insert(carriers).values({
    carrierId: id,
    name: "Test Carrier",
    mcNumber: `MC-${id}`,
    dotNumber: `DOT-${id}`,
    authorityActive: true,
    equipment: ["dry_van"],
    fleetSize: 4,
    onTimeBps: 9300,
    homeRegion: "midwest",
  });
  carrierIds.push(id);
  return id;
}

function booking(negotiationId: string, key: string, carrierId: string) {
  return {
    id: randomUUID(),
    negotiationId,
    loadId: LOAD_ID,
    carrierId,
    linehaulCents: 195_000,
    accessorials: [],
    totalConsiderationCents: 195_000,
    idempotencyKey: key,
  };
}

/** Build a booking row for a fresh negotiation, returning both. */
async function freshBooking(key: string) {
  const carrierId = await newCarrier();
  const negotiationId = randomUUID();
  await db
    .insert(negotiations)
    .values({ id: negotiationId, loadId: LOAD_ID, carrierId, state: "AGREED" });
  negotiationIds.push(negotiationId);
  return booking(negotiationId, key, carrierId);
}

beforeAll(async () => {
  await db.insert(loads).values({
    loadId: LOAD_ID,
    origin: "Chicago, IL",
    destination: "Dallas, TX",
    equipment: "dry_van",
    weightLbs: 42_000,
    commodity: "general freight",
    pickupAt: new Date(),
    customerRateCents: 240_000,
    targetMarginBps: 1500,
    maxCarrierPayCents: 204_000,
    floorCents: 170_000,
  });
  await db.insert(carriers).values({
    carrierId: CARRIER_ID,
    name: "Test Carrier",
    mcNumber: `MC-T${suffix}`,
    dotNumber: `DOT-T${suffix}`,
    authorityActive: true,
    equipment: ["dry_van"],
    fleetSize: 4,
    onTimeBps: 9300,
    homeRegion: "midwest",
  });
});

afterAll(async () => {
  await db.delete(bookings).where(eq(bookings.loadId, LOAD_ID));
  if (negotiationIds.length > 0) {
    await db.delete(negotiations).where(inArray(negotiations.id, negotiationIds));
  }
  if (carrierIds.length > 0) {
    await db.delete(carriers).where(inArray(carriers.carrierId, carrierIds));
  }
  await db.delete(carriers).where(eq(carriers.carrierId, CARRIER_ID));
  await db.delete(loads).where(eq(loads.loadId, LOAD_ID));
  await client.end();
});

describe("the migration", () => {
  it("still creates the vector extension", () => {
    // drizzle-kit does not know about extensions and would silently drop this
    // line on regeneration, leaving a migration that cannot apply to a clean
    // database. This test is the tripwire for that.
    const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(".sql"));
    expect(file).toBeDefined();
    const raw = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    // Strip comments first: the explanatory header above the statement also
    // mentions vector(384), which would satisfy the ordering check below
    // without the statement itself being present at all.
    const sqlText = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sqlText).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/i);
    // The extension must be created before any column uses the type.
    expect(sqlText.indexOf("CREATE EXTENSION")).toBeLessThan(sqlText.indexOf("vector(384)"));
  });

  it("created all eleven tables", async () => {
    const rows = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "bookings", "carrier_lanes", "carriers", "eval_cases", "eval_results",
      "eval_runs", "llm_calls", "loads", "messages", "negotiations", "tool_calls",
    ]);
  });

  it("created the embedding column as vector(384), not as text", async () => {
    const rows = await client<{ t: string }[]>`
      select format_type(atttypid, atttypmod) as t from pg_attribute
      where attrelid = 'carriers'::regclass and attname = 'embedding'`;
    expect(rows[0]?.t).toBe("vector(384)");
  });

  it("kept the partial index on rejected tool calls", async () => {
    const rows = await client<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'ix_tool_calls_rejected'`;
    expect(rows[0]?.indexdef).toContain("WHERE");
    expect(rows[0]?.indexdef).toContain("rejected");
  });
});

describe("bookings.idempotency_key", () => {
  it("is rejected by the database on a duplicate", async () => {
    // Declaring a constraint and having one enforced are different claims.
    // Two DIFFERENT negotiations, one shared key, so only idempotency_key can
    // be the constraint that fires.
    const key = `book-${randomUUID()}`;
    await db.insert(bookings).values(await freshBooking(key));

    const second = await freshBooking(key);
    await expect(db.insert(bookings).values(second)).rejects.toMatchObject({
      code: "23505", // unique_violation
      constraint_name: "bookings_idempotency_key_unique",
    });

    const rows = await db.select().from(bookings).where(eq(bookings.idempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it("makes the retry return the original booking rather than a second one", async () => {
    // The correct pattern: attempt the write, handle the violation. Not
    // "check then write" -- that has a window between the check and the write
    // in which another writer can insert.
    const key = `book-${randomUUID()}`;
    const row = await freshBooking(key);

    async function bookOnce(): Promise<string> {
      try {
        await db.insert(bookings).values(row);
        return row.id;
      } catch (err) {
        if ((err as { code?: string }).code !== "23505") throw err;
        const winner = await db
          .select()
          .from(bookings)
          .where(eq(bookings.idempotencyKey, key));
        return winner[0]!.id;
      }
    }

    expect(await bookOnce()).toBe(await bookOnce());
    expect(await db.select().from(bookings).where(eq(bookings.idempotencyKey, key))).toHaveLength(1);
  });

  it("holds under genuinely concurrent inserts", async () => {
    // The scenario an application-level check cannot survive: every writer
    // reads "no existing booking" before any of them writes. Eight distinct
    // negotiations sharing one key, fired at once -- exactly one may land.
    const key = `book-${randomUUID()}`;
    const rows = await Promise.all(Array.from({ length: 8 }, () => freshBooking(key)));

    const results = await Promise.allSettled(
      rows.map((r) => db.insert(bookings).values(r)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    expect(await db.select().from(bookings).where(eq(bookings.idempotencyKey, key))).toHaveLength(1);
  });
});

describe("the other constraints bite too", () => {
  it("allows only one booking per negotiation, even on a different key", async () => {
    // The second, independent guard: the idempotency key stops the same
    // request being applied twice; this stops two different requests both
    // booking one negotiation.
    const first = await freshBooking(`book-${randomUUID()}`);
    await db.insert(bookings).values(first);

    const second = {
      ...first,
      id: randomUUID(),
      idempotencyKey: `book-${randomUUID()}`,
    };
    await expect(db.insert(bookings).values(second)).rejects.toMatchObject({
      code: "23505",
      constraint_name: "bookings_negotiation_id_unique",
    });
  });

  it("rejects a load whose floor sits above its ceiling", async () => {
    await expect(
      db.insert(loads).values({
        loadId: `T-BAD${suffix.slice(0, 3)}`,
        origin: "A",
        destination: "B",
        equipment: "dry_van",
        weightLbs: 1000,
        commodity: "x",
        pickupAt: new Date(),
        customerRateCents: 100_000,
        targetMarginBps: 1000,
        maxCarrierPayCents: 90_000,
        floorCents: 95_000, // floor above the ceiling: not a load
      }),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "ck_loads_rate_band" });
  });

  it("rejects an unknown negotiation state", async () => {
    const id = await freshBooking(`book-${randomUUID()}`).then((b) => b.negotiationId);
    await expect(
      client`update negotiations set state = 'TELEPORTED' where id = ${id}`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "ck_negotiations_state" });
  });

  it("defaults version to 1 and counter_count to 0 in the database itself", async () => {
    // Real DDL defaults, not application-side ones: a raw INSERT bypassing
    // Drizzle entirely still gets version=1 and counter_count=0.
    const carrierId = await newCarrier();
    const id = randomUUID();
    negotiationIds.push(id);
    await client`
      insert into negotiations (id, load_id, carrier_id, state)
      values (${id}, ${LOAD_ID}, ${carrierId}, 'NEW')`;

    const rows = await client<{ version: number; counter_count: number }[]>`
      select version, counter_count from negotiations where id = ${id}`;
    expect(rows[0]).toMatchObject({ version: 1, counter_count: 0 });
  });
});
