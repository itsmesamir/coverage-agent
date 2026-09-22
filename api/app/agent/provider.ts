/**
 * The LLM behind an interface.
 *
 * Deliberately narrow: one method, plain data in and out. Anything richer --
 * streaming, chat session objects, provider-specific content parts -- would
 * leak a vendor's shape into the agent loop and make swapping providers a
 * rewrite rather than a config change.
 *
 * `LlmResponse` carries the raw provider payload alongside the parsed result.
 * Invariant 5 wants the trace replayable, and a normalised response is lossy:
 * if the model emits something the parser mishandles, the raw payload is the
 * only evidence of what actually happened.
 */

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  /** JSON Schema. Providers accept a subset; the adapter narrows it. */
  readonly parameters: Record<string, unknown>;
}

export type LlmMessage =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "model"; readonly text: string }
  | {
      readonly role: "tool_result";
      readonly toolName: string;
      readonly result: unknown;
    };

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolDeclaration[];
  readonly temperature?: number;
}

export interface ParsedToolCall {
  readonly name: string;
  readonly args: unknown;
}

export interface LlmResponse {
  readonly text: string;
  readonly toolCalls: readonly ParsedToolCall[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelVersion: string | null;
  /** Exactly what the provider returned. Never summarised. */
  readonly raw: unknown;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}
