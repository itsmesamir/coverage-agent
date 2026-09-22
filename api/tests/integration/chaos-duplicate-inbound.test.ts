/**
 * P12, failure mode 1 of 8: duplicate webhook delivery.
 *
 * OBSERVATION ONLY. This test demonstrates the current gap; it does not fix
 * it. Per docs/PLAN.md: observe first, decide expected behaviour, then
 * implement a mitigation and a passing regression test.
 *
 * There is no HTTP webhook endpoint in this codebase today -- carrier replies
 * arrive synchronously via `CarrierResponder.reply()`, not by a third party
 * POSTing to us. But `EmailChannel.receive()` is the function a real inbound
 * webhook handler would call to persist what it delivered, and at-least-once
 * delivery (the thing every real email/SMS webhook provider does under
 * retry) means that function has to tolerate being called twice for one
 * event. Today it has no way to tell "the same event, twice" from "two
 * different replies that happen to say the same thing" -- there is no
 * delivery id, message id, or content hash anywhere on the inbound path.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, createDb } from "../../app/db/client.js";
import { carriers, loads, messages, negotiations } from "../../app/db/schema.js";
import { EmailChannel } from "../../app/channels/email.js";

const client = createClient();
const db = createDb(client);

let liveIds: { negotiationId: string; loadId: string; carrierId: string } | null = null;

async function freshNegotiation(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const loadId = `T-${suffix.slice(0, 6)}`;
  const carrierId = `TC-${suffix.slice(0, 6)}`;
  const negotiationId = randomUUID();

  await db.insert(loads).values({
    loadId,
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
    carrierId,
    name: "T",
    mcNumber: `MC-V${suffix}`,
    dotNumber: `DOT-V${suffix}`,
    authorityActive: true,
    equipment: ["dry_van"],
    fleetSize: 2,
    onTimeBps: 9000,
    homeRegion: "midwest",
  });
  await db.insert(negotiations).values({
    id: negotiationId,
    loadId,
    carrierId,
    state: "NEGOTIATING",
    version: 1,
  });

  liveIds = { negotiationId, loadId, carrierId };
  return negotiationId;
}

afterEach(async () => {
  if (!liveIds) return;
  await db.delete(messages).where(eq(messages.negotiationId, liveIds.negotiationId));
  await db.delete(negotiations).where(eq(negotiations.id, liveIds.negotiationId));
  await db.delete(carriers).where(eq(carriers.carrierId, liveIds.carrierId));
  await db.delete(loads).where(eq(loads.loadId, liveIds.loadId));
  liveIds = null;
});

describe("CHAOS OBSERVATION: duplicate webhook delivery (not yet fixed)", () => {
  it("delivering the same carrier reply twice persists it twice", async () => {
    const negotiationId = await freshNegotiation();
    const channel = new EmailChannel(db);

    // One real event: the carrier's mail provider (or ours) redelivers the
    // same webhook payload -- same body, same negotiation -- because the
    // first response timed out or was never acked. This is not hypothetical:
    // it is the documented behaviour of every major inbound-email and SMS
    // webhook provider under retry.
    const redelivered = {
      negotiationId,
      body: "We'd need $2,150 to make this work, plus detention if we sit.",
    };

    await channel.receive(redelivered);
    await channel.receive(redelivered); // the retry

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.negotiationId, negotiationId));

    // What SHOULD be true of a correctly deduplicated inbound channel: one
    // event in, one row out. What IS true today, asserted here to make the
    // gap concrete rather than argued: two calls, two indistinguishable
    // rows. Nothing on the `messages` table -- no delivery id, no content
    // hash, no unique constraint -- could tell these apart after the fact.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body).toBe(rows[1]?.body);
  });
});
