import { describe, expect, it } from "vitest";

import {
  DailyQuotaExhausted, isDailyQuota, isNetworkError, retryAfterMs, withRetry,
} from "../../app/agent/providers/gemini.js";

const noSleep = async () => {};

function apiError(status: number, message = ""): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls += 1; return "ok"; }, 5, noSleep);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a rate limit and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw apiError(429, "RESOURCE_EXHAUSTED");
      return "ok";
    }, 5, noSleep);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("honours the server's own retryDelay rather than guessing", async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw apiError(429, '{"retryDelay":"4.2967338s"}');
      return "ok";
    }, 5, async (ms) => { waits.push(ms); });
    // 4.2967s rounds up to 4297ms, plus the fixed 250ms cushion.
    expect(waits).toEqual([4547]);
  });

  it("does not retry a malformed request", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw apiError(400, "INVALID_ARGUMENT");
    }, 5, noSleep)).rejects.toThrow();
    // Retrying a 400 fails identically, wastes quota, and hides the bug.
    expect(calls).toBe(1);
  });

  it("retries transient server errors", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw apiError(503);
    }, 3, noSleep)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("does not retry a daily quota, because waiting cannot clear it", async () => {
    // The first version spent five minutes backing off against a quota that
    // resets tomorrow, then failed anyway.
    let calls = 0;
    const dailyQuota = Object.assign(
      new Error('{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}'),
      { status: 429 },
    );
    await expect(
      withRetry(async () => { calls += 1; throw dailyQuota; }, 5, noSleep, "gemini-3.6-flash"),
    ).rejects.toBeInstanceOf(DailyQuotaExhausted);
    expect(calls).toBe(1);
  });

  it("tells the caller what to actually do about a daily quota", async () => {
    const error = new DailyQuotaExhausted("gemini-3.6-flash", null);
    expect(error.message).toContain("gemini-3.6-flash");
    expect(error.message).toContain("AGENT_MODEL");
  });

  it("distinguishes a per-minute limit from a per-day budget", () => {
    expect(isDailyQuota(new Error('{"quotaId":"...PerDayPerProjectPerModel..."}'))).toBe(true);
    expect(isDailyQuota(new Error('{"quotaId":"...PerMinutePerProjectPerModel..."}'))).toBe(false);
  });

  it("honours each provider's way of stating the wait", () => {
    // Gemini puts it in a JSON field, Groq writes it in prose. Parsing only
    // one meant the other's hint was ignored and met with a guess.
    expect(retryAfterMs(new Error('{"retryDelay":"4.68s"}'))).toBe(4680);
    expect(retryAfterMs(new Error("Rate limit reached. Please try again in 4.68s."))).toBe(4680);
    expect(retryAfterMs(new Error("retry-after: 12"))).toBe(12_000);
    expect(retryAfterMs(new Error("no hint here"))).toBeNull();
  });

  it("waits exactly as long as a Groq 429 asked", async () => {
    const waits: number[] = [];
    let calls = 0;
    const groq429 = Object.assign(
      new Error(
        'Groq 429: {"error":{"message":"Rate limit reached for model `qwen` on output ' +
          'tokens per minute (OTPM): Limit 1000, Used 727. Please try again in 4.68s."}}',
      ),
      { status: 429 },
    );
    await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw groq429;
      return "ok";
    }, 5, async (ms) => { waits.push(ms); });
    expect(waits).toEqual([4930]); // 4.68s rounded up, plus the fixed cushion
  });

  it("retries a dropped connection", async () => {
    // A network failure carries no HTTP status, so a status-only check misses
    // it entirely. One ECONNRESET took down a whole eval suite mid-run before
    // this.
    let calls = 0;
    const dropped = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw dropped;
      return "ok";
    }, 5, noSleep);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("recognises network failures however deeply the cause is nested", () => {
    expect(isNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(
      isNetworkError(
        Object.assign(new Error("outer"), {
          cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }),
        }),
      ),
    ).toBe(true);
    expect(isNetworkError(new Error("INVALID_ARGUMENT"))).toBe(false);
  });

  it("does not loop forever on a self-referencing cause chain", () => {
    const loop = new Error("a") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(isNetworkError(loop)).toBe(false);
  });

  it("gives up after the attempt budget and rethrows the last error", async () => {
    await expect(
      withRetry(async () => { throw apiError(429, "RESOURCE_EXHAUSTED"); }, 2, noSleep),
    ).rejects.toThrow("RESOURCE_EXHAUSTED");
  });
});
