/**
 * Content-addressed cache for LLM responses.
 *
 * The single biggest quota saver in a free-tier setup, because development is
 * overwhelmingly re-running the same thing. Fix a bug in the loop, rerun the
 * negotiation: the first N model turns are byte-identical requests and should
 * not cost a request each time.
 *
 * The key is a hash of everything that could change the answer -- provider,
 * model, prompt version, system text, the full message history, and the tool
 * declarations. If any of those differ the cache misses, which is the correct
 * behaviour: a cached answer to a different question is worse than no cache.
 *
 * Deliberately NOT the same thing as eval replay. Replay re-scores stored
 * traces without calling a model at all, and is how metrics stay free. This
 * cache makes the *generation* side cheap while the agent is being built. They
 * solve different problems and both are needed.
 *
 * Temperature is assumed 0. At higher temperatures caching would hide the
 * variance that matters, so the cache should be off for any run measuring it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { LlmProvider, LlmRequest, LlmResponse } from "../provider.js";

export interface CacheStats {
  hits: number;
  misses: number;
}

export function requestFingerprint(
  provider: string,
  model: string,
  request: LlmRequest,
): string {
  const canonical = JSON.stringify({
    provider,
    model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    temperature: request.temperature ?? 0,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class CachingProvider implements LlmProvider {
  readonly stats: CacheStats = { hits: 0, misses: 0 };

  constructor(
    private readonly inner: LlmProvider,
    private readonly directory: string,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const key = requestFingerprint(this.inner.name, this.inner.model, request);
    // Two hex chars of fan-out: a flat directory of thousands of files is
    // slow to list and unpleasant to inspect by hand.
    const path = join(this.directory, key.slice(0, 2), `${key}.json`);

    const cached = await readCache(path);
    if (cached) {
      this.stats.hits += 1;
      return cached;
    }

    this.stats.misses += 1;
    const response = await this.inner.generate(request);
    await writeCache(path, response);
    return response;
  }
}

async function readCache(path: string): Promise<LlmResponse | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LlmResponse;
  } catch {
    // A missing or corrupt entry is a miss, never an error. A cache that can
    // fail a run is worse than no cache.
    return null;
  }
}

async function writeCache(path: string, response: LlmResponse): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(response), "utf8");
  } catch {
    // Same reasoning: failing to cache must not fail the negotiation.
  }
}
