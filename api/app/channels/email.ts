/**
 * Email transport. Mocked -- nothing leaves this process.
 *
 * Called mocked rather than "in-memory adapter" because that is what it is: no
 * SMTP, no deliverability, no bounce handling, no threading beyond a subject
 * line. What it faithfully models is the part the rest of the system depends
 * on: messages go out, replies come back, both are persisted in order, and the
 * transcript can be reconstructed from the database.
 *
 * The carrier side is a `CarrierResponder`: today a scripted function, later
 * an LLM-driven persona. The loop cannot tell the difference, which is the
 * point of the seam.
 */

import { randomUUID } from "node:crypto";

import type { Database } from "../db/client.js";
import { messages } from "../db/schema.js";
import type { RenderedMessage } from "../agent/render.js";

export interface OutboundEmail extends RenderedMessage {
  readonly negotiationId: string;
  /** The tool call whose approved decision produced this body. */
  readonly renderedFromToolCallId: string | null;
}

export interface InboundEmail {
  readonly negotiationId: string;
  readonly body: string;
}

export interface CarrierResponder {
  /** Return the carrier's reply, or null for silence. */
  reply(outbound: RenderedMessage, turn: number): Promise<string | null>;
}

/** Replies from a fixed script. Silence once the script runs out. */
export class ScriptedCarrier implements CarrierResponder {
  readonly received: RenderedMessage[] = [];
  private index = 0;

  constructor(private readonly script: readonly string[]) {}

  async reply(outbound: RenderedMessage): Promise<string | null> {
    this.received.push(outbound);
    const next = this.script[this.index];
    this.index += 1;
    return next ?? null;
  }
}

export class EmailChannel {
  constructor(private readonly db: Database) {}

  async send(email: OutboundEmail): Promise<string> {
    const id = randomUUID();
    await this.db.insert(messages).values({
      id,
      negotiationId: email.negotiationId,
      direction: "outbound",
      channel: "email",
      body: `Subject: ${email.subject}\n\n${email.body}`,
      renderedFromToolCallId: email.renderedFromToolCallId,
    });
    return id;
  }

  async receive(email: InboundEmail): Promise<string> {
    const id = randomUUID();
    await this.db.insert(messages).values({
      id,
      negotiationId: email.negotiationId,
      direction: "inbound",
      channel: "email",
      body: email.body,
      // Inbound text is never rendered from a decision, and saying so
      // explicitly is what lets the audit query "every outbound price traces to
      // an approved tool call" be written at all.
      renderedFromToolCallId: null,
    });
    return id;
  }
}
