/**
 * A pool of (key, model) pairs that fails over when a daily quota runs out.
 *
 * The Gemini free tier meters requests per project, per model, per day. That
 * makes the daily budget a product rather than a number: N keys across N
 * projects, times M models in the fallback chain. A 50-case eval suite is not
 * runnable against one key and one model; across a pool it is.
 *
 * What this is NOT: a load balancer. It does not spread traffic to go faster or
 * to hide from limits. It stays on the first, best member until that member is
 * genuinely exhausted for the day, then moves down. The ordering is a quality
 * preference and the pool only descends it under duress.
 *
 * Every trace records the model that actually answered. That matters more than
 * it sounds: if a run silently fell back to a weaker model, the eval numbers
 * moved for a reason that has nothing to do with the code, and the trace is the
 * only place that is visible.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from "../provider.js";
import { DailyQuotaExhausted } from "./gemini.js";

export interface PoolMember {
  readonly label: string;
  readonly provider: LlmProvider;
}

export class ProviderPool implements LlmProvider {
  readonly name = "pool";
  /** Members whose daily quota is spent. Cleared only by restarting the process. */
  private readonly exhausted = new Set<string>();
  private cursor = 0;

  constructor(private readonly members: readonly PoolMember[]) {
    if (members.length === 0) throw new Error("ProviderPool needs at least one member");
  }

  get model(): string {
    return this.current().provider.model;
  }

  /** Which member answered last. Recorded on the trace. */
  current(): PoolMember {
    return this.members[this.cursor]!;
  }

  get remaining(): number {
    return this.members.length - this.exhausted.size;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;

    for (let tried = 0; tried < this.members.length; tried += 1) {
      const member = this.members[this.cursor]!;
      if (this.exhausted.has(member.label)) {
        this.advance();
        continue;
      }
      try {
        return await member.provider.generate(request);
      } catch (error) {
        lastError = error;
        if (!(error instanceof DailyQuotaExhausted)) throw error;
        // Out of budget for today, not a transient failure. Retiring this
        // member for the process lifetime avoids paying the same 429 again on
        // every subsequent call.
        this.exhausted.add(member.label);
        this.advance();
      }
    }

    throw new Error(
      `Every provider in the pool is out of daily quota (${this.members
        .map((m) => m.label)
        .join(", ")}). Add another key or model, or wait for the reset.`,
      { cause: lastError },
    );
  }

  private advance(): void {
    this.cursor = (this.cursor + 1) % this.members.length;
  }
}
