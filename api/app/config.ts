/**
 * Configuration. The only place a model name or an API key is read.
 *
 * Model names live here and in `.env`, never in a prompt, a tool description or
 * a call site. Two reasons: the eval harness records which model produced a run
 * (a metric that moved because the model changed is not a regression in the
 * code), and swapping providers must not require touching agent logic.
 */

import "dotenv/config";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function list(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Every Gemini key available, in order.
 *
 * The free tier meters per project per model per day, so N keys across N
 * projects multiply the daily budget. Singular GEMINI_API_KEY still works and is
 * treated as a pool of one.
 */
export function geminiKeys(): string[] {
  const many = list("GEMINI_API_KEYS");
  if (many.length > 0) return many;
  const single = env("GEMINI_API_KEY");
  return single ? [single] : [];
}

export function groqKeys(): string[] {
  const many = list("GROQ_API_KEYS");
  if (many.length > 0) return many;
  const single = env("GROQ_API_KEY");
  return single ? [single] : [];
}

/**
 * The model fallback chain, best first.
 *
 * Daily quota is per model, so exhausting one does not exhaust the next. The
 * order is a quality preference: the pool only moves down it under duress, and
 * every trace records which model actually answered, so a metric that moved
 * because the run fell back to a weaker model is visible rather than mysterious.
 */
export function agentModels(): string[] {
  const configured = list("AGENT_MODELS");
  if (configured.length > 0) return configured;
  const single = env("AGENT_MODEL");
  return single ? [single] : ["gemini-3.6-flash"];
}

export function simulationModels(): string[] {
  const configured = list("SIM_MODELS");
  if (configured.length > 0) return configured;
  const single = env("SIM_MODEL");
  return single ? [single] : ["qwen/qwen3.8-27b"];
}

/** Where cached LLM responses live. Set LLM_CACHE=off to disable. */
export function llmCacheDir(): string | null {
  if ((env("LLM_CACHE") ?? "on").toLowerCase() === "off") return null;
  return env("LLM_CACHE_DIR") ?? ".cache/llm";
}

/** Hard caps on a negotiation. Bounds on cost and turns, not business rules. */
export const LIMITS = {
  /** Agent turns before we escalate rather than continue. */
  maxTurns: 12,
  /** Consecutive policy rejections within one turn before escalating. */
  maxReplans: 3,
  /** Tool calls the model may make in a single turn. */
  maxToolCallsPerTurn: 6,
} as const;
