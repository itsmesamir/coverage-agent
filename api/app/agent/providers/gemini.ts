/**
 * Gemini adapter. The only file that knows Gemini's request shape.
 *
 * Tool calling is forced into a mode where the model must either call a tool or
 * answer -- it may not do both in one turn -- because interleaving a tool call
 * with prose invites the model to announce a price in text before the engine
 * has approved one. The loop only ever sends rendered templates to a carrier,
 * so prose is harmless, but keeping turns single-purpose makes traces far
 * easier to read and the tool-call metric far easier to define.
 */

import { GoogleGenAI, type FunctionDeclaration } from "@google/genai";

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ParsedToolCall,
  ToolDeclaration,
} from "../provider.js";

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const response = await withRetry(
      () => this.call(request),
      5,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      this.model,
    );
    return response;
  }

  private async call(request: LlmRequest) {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: request.messages.map(toGeminiContent),
      config: {
        systemInstruction: request.system,
        temperature: request.temperature ?? 0,
        tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }],
      },
    });

    const toolCalls: ParsedToolCall[] = (response.functionCalls ?? []).map((call) => ({
      name: call.name ?? "",
      args: call.args ?? {},
    }));

    return {
      // Reading `.text` when the model returned a functionCall makes the SDK
      // warn about discarded non-text parts. Prose and tool calls are separate
      // turns here anyway.
      text: toolCalls.length > 0 ? "" : (response.text ?? ""),
      toolCalls,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      modelVersion: response.modelVersion ?? null,
      raw: response,
    };
  }
}

/**
 * However long the API asked us to wait, if it said.
 *
 * Providers state this differently and both are honoured, because guessing a
 * backoff when the server has told you the answer is how you get throttled
 * harder. Gemini puts it in a `retryDelay` JSON field; Groq writes it in prose
 * ("Please try again in 4.68s"). Parsing only the first meant Groq's hint was
 * ignored and a per-minute token budget was met with an exponential guess that
 * gave up too early.
 */
export function retryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/, // Gemini
    /try again in\s+(\d+(?:\.\d+)?)\s*s/i, // Groq
    /retry-after:\s*(\d+(?:\.\d+)?)/i, // header echoed into a message
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) return Math.ceil(Number(match[1]) * 1000);
  }
  return null;
}

function isRateLimit(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return status === 429 || message.includes("RESOURCE_EXHAUSTED");
}

/**
 * A per-DAY quota is not a rate limit, it is a budget, and waiting will not
 * clear it. Retrying one burns minutes to arrive at the same failure -- the
 * first version of this spent five minutes backing off against a quota that
 * resets tomorrow. Fail immediately with something actionable instead.
 */
export function isDailyQuota(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PerDay|RequestsPerDay/i.test(message);
}

export class DailyQuotaExhausted extends Error {
  constructor(model: string, cause: unknown) {
    super(
      `Daily free-tier request quota exhausted for ${model}. Waiting will not help; ` +
        `it resets on Google's clock. Add another model to AGENT_MODELS or another ` +
        `key to GEMINI_API_KEYS in .env, or use a billed key.`,
    );
    this.name = "DailyQuotaExhausted";
    this.cause = cause;
  }
}

function isTransient(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  return isNetworkError(error);
}

/**
 * A connection that dropped, refused, timed out or failed to resolve.
 *
 * These carry no HTTP status -- there was no HTTP response -- so a
 * status-based check misses them entirely and the error propagates on the
 * first occurrence. That is how one dropped TCP connection took down a whole
 * eval suite mid-run. A dropped connection is the textbook transient failure
 * and is exactly what retry is for.
 */
export function isNetworkError(error: unknown): boolean {
  const codes = new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET",
  ]);
  const seen = new Set<unknown>();
  let current: unknown = error;
  // Undici nests the real cause, so the useful code is often one or two levels
  // down rather than on the error that was thrown.
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (typeof code === "string" && codes.has(code)) return true;
    const message = current instanceof Error ? current.message : "";
    if (/fetch failed|network|socket hang up/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Retry on rate limits and transient server errors.
 *
 * The free tier allows a handful of requests per minute and a negotiation needs
 * more than that, so this is load-bearing rather than defensive. It honours the
 * server's own `retryDelay` when given one, because guessing a backoff when the
 * API has told you the answer is how you get throttled harder.
 *
 * Deliberately does NOT retry 4xx other than 429: a malformed request will fail
 * identically the second time, and retrying it wastes quota and hides the bug.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  attempts = 5,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  model = "the configured model",
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isDailyQuota(error)) throw new DailyQuotaExhausted(model, error);
      if (!isRateLimit(error) && !isTransient(error)) throw error;
      if (attempt === attempts - 1) break;
      // Cap at 65s: the limits that bite here are per-minute windows, and a
      // ceiling below one minute cannot outlast one.
      const wait = retryAfterMs(error) ?? Math.min(65_000, 1_000 * 2 ** attempt);
      await sleep(wait + 250);
    }
  }
  throw lastError;
}

function toFunctionDeclaration(tool: ToolDeclaration): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  };
}

function toGeminiContent(message: LlmRequest["messages"][number]) {
  if (message.role === "tool_result") {
    // Tool results go back as a user turn rather than a functionResponse part.
    // The loop re-reads authoritative state from the database before every
    // policy decision, so the model's view of a result is context, not a
    // source of truth, and a plain text turn keeps the trace readable.
    return {
      role: "user" as const,
      parts: [{ text: `Result of ${message.toolName}:\n${JSON.stringify(message.result)}` }],
    };
  }
  return { role: message.role, parts: [{ text: message.text }] };
}

/** In-memory provider for tests: scripted responses, no network, no cost. */
export class StubProvider implements LlmProvider {
  readonly name = "stub";
  readonly calls: LlmRequest[] = [];
  private index = 0;

  constructor(
    readonly model: string,
    private readonly script: readonly Partial<LlmResponse>[],
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const next = this.script[this.index] ?? {};
    this.index += 1;
    return {
      text: next.text ?? "",
      toolCalls: next.toolCalls ?? [],
      inputTokens: next.inputTokens ?? 100,
      outputTokens: next.outputTokens ?? 20,
      modelVersion: next.modelVersion ?? "stub-001",
      raw: next.raw ?? { scripted: true },
    };
  }
}
