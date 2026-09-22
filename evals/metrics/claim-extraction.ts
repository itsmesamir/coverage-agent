/**
 * Turn an outbound message into a list of atomic factual claims.
 *
 * The model's ONLY job here is to read prose and enumerate what it asserts. It
 * is never told what the load actually says, never asked whether a claim is
 * true, and never sees the ground truth -- so it cannot agree with the agent
 * out of shared plausibility, which is the failure mode that makes
 * LLM-as-judge unreliable. Truth is settled afterwards by `verifyClaim`
 * against the load row.
 *
 * Output is validated with zod before anything downstream sees it. A model
 * will occasionally return prose around its JSON, an extra field, or a number
 * as a string; that is a normal failure and is handled rather than trusted.
 */

import { z } from "zod";

import type { LlmProvider } from "../../api/app/agent/provider.js";
import { CLAIM_KINDS, type Claim } from "./hallucination.js";

export const EXTRACTION_PROMPT_VERSION = "claims-v1";

const claimSchema = z.object({
  kind: z.enum(CLAIM_KINDS),
  text: z.string().min(1).max(300),
  value: z.union([z.string(), z.number(), z.null()]),
});

const responseSchema = z.object({ claims: z.array(claimSchema).max(40) });

export const EXTRACTION_SYSTEM = `
You extract factual claims from freight emails. You do not judge them.

Return JSON only, in this exact shape:
{"claims":[{"kind":"...","text":"...","value":...}]}

kind is one of: money, weight, pickup, commodity, equipment, origin,
destination, load_id, carrier, other.

value must be normalised:
- money: integer CENTS. "$1,950.00" becomes 195000.
- weight: integer pounds. "42,000 lbs" becomes 42000.
- pickup: ISO 8601. "2026-09-17 at 08:00 UTC" becomes "2026-09-17T08:00:00Z".
- everything else: the plain string as written.
- null if the sentence asserts something but pins no specific value.

Rules:
- One claim per fact. Split compound sentences.
- Extract only assertions of fact. Greetings, requests and pleasantries are
  not claims and should be omitted entirely.
- Anything that is a statement but not checkable against a shipment record
  ("we will move quickly", "thanks for your time") is kind "other".
- Never invent a claim the text does not make. If the email asserts nothing
  factual, return {"claims":[]}.
`.trim();

/** Pull the JSON object out of a response that may be wrapped in prose or a fence. */
export function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

export function parseClaims(raw: string): Claim[] {
  const json = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) return [];

  return result.data.claims.map((c) => ({
    kind: c.kind,
    text: c.text,
    // A money or weight value arriving as "195000" is the model being loose
    // with types, not a different claim, so coerce rather than discard.
    value: coerce(c.kind, c.value),
  }));
}

function coerce(kind: Claim["kind"], value: string | number | null): string | number | null {
  if (value === null) return null;
  if (kind === "money" || kind === "weight") {
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
    const digits = value.replace(/[^0-9.-]/g, "");
    const n = Number(digits);
    return digits.length > 0 && Number.isFinite(n) ? Math.round(n) : null;
  }
  return typeof value === "number" ? String(value) : value;
}

export async function extractClaims(
  provider: LlmProvider,
  messageBody: string,
): Promise<Claim[]> {
  const response = await provider.generate({
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", text: messageBody }],
    tools: [],
    temperature: 0,
  });
  return parseClaims(response.text);
}
