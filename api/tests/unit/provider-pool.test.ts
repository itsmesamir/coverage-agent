import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CachingProvider, requestFingerprint } from "../../app/agent/providers/cache.js";
import { DailyQuotaExhausted } from "../../app/agent/providers/gemini.js";
import { ProviderPool } from "../../app/agent/providers/pool.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../app/agent/provider.js";

const REQUEST: LlmRequest = { system: "sys", messages: [{ role: "user", text: "hi" }], tools: [] };

function response(over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    text: "", toolCalls: [], inputTokens: 1, outputTokens: 1,
    modelVersion: "v", raw: {}, ...over,
  };
}

class FakeProvider implements LlmProvider {
  calls = 0;
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly behaviour: () => Promise<LlmResponse>,
  ) {}
  async generate(): Promise<LlmResponse> {
    this.calls += 1;
    return this.behaviour();
  }
}

const ok = (text: string) => new FakeProvider("fake", "m", async () => response({ text }));
const dead = (model: string) =>
  new FakeProvider("fake", model, async () => {
    throw new DailyQuotaExhausted(model, null);
  });

describe("ProviderPool", () => {
  it("stays on the first member while it works", async () => {
    const first = ok("first");
    const second = ok("second");
    const pool = new ProviderPool([
      { label: "a", provider: first },
      { label: "b", provider: second },
    ]);
    await pool.generate(REQUEST);
    await pool.generate(REQUEST);
    expect(first.calls).toBe(2);
    expect(second.calls).toBe(0);
  });

  it("fails over when a member's daily quota is gone", async () => {
    const spent = dead("m1");
    const fresh = ok("from second");
    const pool = new ProviderPool([
      { label: "a", provider: spent },
      { label: "b", provider: fresh },
    ]);
    const result = await pool.generate(REQUEST);
    expect(result.text).toBe("from second");
  });

  it("does not retry a member already known to be exhausted", async () => {
    const spent = dead("m1");
    const fresh = ok("ok");
    const pool = new ProviderPool([
      { label: "a", provider: spent },
      { label: "b", provider: fresh },
    ]);
    await pool.generate(REQUEST);
    await pool.generate(REQUEST);
    await pool.generate(REQUEST);
    // Asked once, retired, never asked again -- otherwise every later call pays
    // the same 429 before getting anywhere.
    expect(spent.calls).toBe(1);
    expect(fresh.calls).toBe(3);
  });

  it("propagates errors that are not quota exhaustion", async () => {
    const broken = new FakeProvider("fake", "m", async () => {
      throw new Error("malformed request");
    });
    const pool = new ProviderPool([
      { label: "a", provider: broken },
      { label: "b", provider: ok("unused") },
    ]);
    // A bug must not be silently masked by falling back to another model.
    await expect(pool.generate(REQUEST)).rejects.toThrow("malformed request");
  });

  it("reports how much budget is left", async () => {
    const pool = new ProviderPool([
      { label: "a", provider: dead("m1") },
      { label: "b", provider: ok("ok") },
    ]);
    expect(pool.remaining).toBe(2);
    await pool.generate(REQUEST);
    expect(pool.remaining).toBe(1);
  });

  it("explains what to do when everything is exhausted", async () => {
    const pool = new ProviderPool([
      { label: "gemini:a", provider: dead("m1") },
      { label: "gemini:b", provider: dead("m2") },
    ]);
    await expect(pool.generate(REQUEST)).rejects.toThrow(/out of daily quota.*gemini:a, gemini:b/s);
  });

  it("refuses to be built empty", () => {
    expect(() => new ProviderPool([])).toThrow();
  });
});

describe("CachingProvider", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "llm-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("calls the model once for identical requests", async () => {
    const inner = ok("answer");
    const cached = new CachingProvider(inner, dir);
    expect((await cached.generate(REQUEST)).text).toBe("answer");
    expect((await cached.generate(REQUEST)).text).toBe("answer");
    expect(inner.calls).toBe(1);
    expect(cached.stats).toEqual({ hits: 1, misses: 1 });
  });

  it("misses when the message history differs", async () => {
    const inner = ok("answer");
    const cached = new CachingProvider(inner, dir);
    await cached.generate(REQUEST);
    await cached.generate({ ...REQUEST, messages: [{ role: "user", text: "different" }] });
    expect(inner.calls).toBe(2);
  });

  it("misses when the tools differ, because the answer could change", async () => {
    const inner = ok("answer");
    const cached = new CachingProvider(inner, dir);
    await cached.generate(REQUEST);
    await cached.generate({
      ...REQUEST,
      tools: [{ name: "t", description: "d", parameters: {} }],
    });
    expect(inner.calls).toBe(2);
  });

  it("keys on the model, so two models never share an answer", () => {
    const a = requestFingerprint("gemini", "model-a", REQUEST);
    const b = requestFingerprint("gemini", "model-b", REQUEST);
    expect(a).not.toBe(b);
  });

  it("is stable across runs for the same input", () => {
    expect(requestFingerprint("gemini", "m", REQUEST)).toBe(
      requestFingerprint("gemini", "m", REQUEST),
    );
  });

  it("treats an unwritable cache as a miss rather than an error", async () => {
    const inner = ok("answer");
    const cached = new CachingProvider(inner, "/proc/definitely-not-writable");
    // A cache that can fail a run is worse than no cache.
    expect((await cached.generate(REQUEST)).text).toBe("answer");
  });
});
