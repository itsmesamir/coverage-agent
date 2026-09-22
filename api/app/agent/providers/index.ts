/**
 * Builds the agent's provider from configuration.
 *
 * The composition, outermost first:
 *
 *   CachingProvider          identical request -> no network call at all
 *     └── ProviderPool       fails over when a member's daily quota is gone
 *           ├── gemini key A / model 1      <- best
 *           ├── gemini key A / model 2
 *           ├── gemini key B / model 1
 *           └── groq key / model            <- last resort, weaker tool calling
 *
 * Order matters and is a quality preference, not a round robin. The pool stays
 * on the first member until it is genuinely exhausted for the day.
 */

import { agentModels, geminiKeys, groqKeys, llmCacheDir, simulationModels } from "../../config.js";
import type { LlmProvider } from "../provider.js";
import { CachingProvider } from "./cache.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { ProviderPool, type PoolMember } from "./pool.js";

function shortKey(key: string): string {
  return key.slice(-6);
}

/** Every usable (key, model) pair, best first. */
export function agentPoolMembers(): PoolMember[] {
  const members: PoolMember[] = [];

  const models = agentModels();
  const gemini = geminiKeys();
  // Model-major order: exhaust the best model across every key before
  // dropping to a weaker one. Falling back on quality is the last resort.
  for (const model of models) {
    for (const key of gemini) {
      members.push({
        label: `gemini:${model}:${shortKey(key)}`,
        provider: new GeminiProvider(model, key),
      });
    }
  }

  for (const key of groqKeys()) {
    for (const model of simulationModels()) {
      members.push({
        label: `groq:${model}:${shortKey(key)}`,
        provider: new GroqProvider(model, key),
      });
    }
  }

  return members;
}

export function buildAgentProvider(): LlmProvider {
  const members = agentPoolMembers();
  if (members.length === 0) {
    throw new Error(
      "No LLM credentials. Set GEMINI_API_KEYS (comma separated) or GROQ_API_KEYS in .env.",
    );
  }
  const pool = new ProviderPool(members);
  const cache = llmCacheDir();
  return cache ? new CachingProvider(pool, cache) : pool;
}

/** Personas and the claim extractor: cheap, high volume, no tool calling. */
export function buildSimulationProvider(): LlmProvider {
  const members: PoolMember[] = [];
  for (const model of simulationModels()) {
    for (const key of groqKeys()) {
      members.push({
        label: `groq:${model}:${shortKey(key)}`,
        provider: new GroqProvider(model, key),
      });
    }
  }
  if (members.length === 0) {
    throw new Error("No GROQ_API_KEYS set; carrier personas need one.");
  }
  const pool = new ProviderPool(members);
  const cache = llmCacheDir();
  return cache ? new CachingProvider(pool, cache) : pool;
}

export { CachingProvider, GeminiProvider, GroqProvider, ProviderPool };
