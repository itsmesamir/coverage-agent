/**
 * Groq adapter, via the OpenAI-compatible chat completions API.
 *
 * Written with `fetch` rather than an SDK: the surface we use is one POST, and
 * a dependency that wraps one POST is a dependency that will need updating.
 *
 * Why Groq is here at all. Gemini's free tier meters ~20 requests per model per
 * project per day, which is roughly two negotiations; Groq's free limits are
 * orders of magnitude higher. That makes Groq the practical choice for the
 * high-volume, low-stakes calls -- carrier personas and the hallucination claim
 * extractor -- and a usable fallback for the agent itself when Gemini's budget
 * is gone.
 *
 * The honest caveat, which belongs in the README and not buried here: open
 * models are less reliable at structured tool calling than Gemini. Running the
 * agent on Groq will show up as a lower tool-call correctness score, and that
 * is a property of the model, not a regression in the code. The trace records
 * which model answered precisely so the two can be told apart.
 */

import { withRetry } from "./gemini.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ParsedToolCall,
  ToolDeclaration,
} from "../provider.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

interface GroqToolCall {
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface GroqResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null; readonly tool_calls?: GroqToolCall[] };
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

export class GroqProvider implements LlmProvider {
  readonly name = "groq";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const body = {
      model: this.model,
      temperature: request.temperature ?? 0,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map(toGroqMessage),
      ],
      ...(request.tools.length > 0 ? { tools: request.tools.map(toGroqTool) } : {}),
    };

    // withRetry's quota detection is Gemini-shaped (it looks for
    // RESOURCE_EXHAUSTED and a PerDay quota id in the error message). A Groq
    // 429 still retries correctly as a rate limit via the plain status check,
    // but a Groq daily quota, if one exists, would not be recognized as such
    // and would retry uselessly rather than failing fast.
    const raw = await withRetry(
      async () => {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const text = await response.text();
          throw Object.assign(new Error(`Groq ${response.status}: ${text}`), {
            status: response.status,
          });
        }
        return (await response.json()) as GroqResponse;
      },
      5,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      this.model,
    );

    const message = raw.choices?.[0]?.message;
    const toolCalls: ParsedToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      name: call.function?.name ?? "",
      // Arguments arrive as a JSON string. Malformed JSON is the model's
      // problem to recover from, so it becomes an empty object and the tool
      // layer's schema validation produces a rejection the agent can re-plan on.
      args: safeParse(call.function?.arguments),
    }));

    return {
      text: toolCalls.length > 0 ? "" : (message?.content ?? ""),
      toolCalls,
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
      modelVersion: raw.model ?? null,
      raw,
    };
  }
}

function safeParse(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toGroqTool(tool: ToolDeclaration) {
  return {
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toGroqMessage(message: LlmRequest["messages"][number]) {
  if (message.role === "tool_result") {
    return {
      role: "user" as const,
      content: `Result of ${message.toolName}:\n${JSON.stringify(message.result)}`,
    };
  }
  return {
    role: message.role === "model" ? ("assistant" as const) : ("user" as const),
    content: message.text,
  };
}
