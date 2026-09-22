/**
 * Grounded claim checking over outbound messages.
 *
 * Two halves, deliberately split:
 *
 *   extraction     an LLM reads a message and lists the atomic factual claims
 *                  it makes. Judgement-free: it says what was asserted, never
 *                  whether the assertion is true.
 *
 *   verification   pure code compares each claim against the authoritative
 *                  record and marks it supported, unsupported or ambiguous.
 *
 * The split is the whole design. An LLM asked "is this message accurate?"
 * produces an opinion with no error bar, and its mistakes correlate with the
 * mistakes of the model being evaluated -- both share training data, both
 * find the same things plausible. Deterministic verification against the load
 * row cannot be talked into agreeing. What is left for the model is the part
 * it is genuinely good at and that is cheap to check: reading prose and
 * enumerating what it asserts.
 *
 * This module is the pure half. Extraction lives in `claim-extraction.ts`.
 */

export const CLAIM_KINDS = [
  "money",
  "weight",
  "pickup",
  "commodity",
  "equipment",
  "origin",
  "destination",
  "load_id",
  "carrier",
  "other",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface Claim {
  readonly kind: ClaimKind;
  /** The assertion as written, for the report. */
  readonly text: string;
  /**
   * Normalised value. Money in integer cents, weight in pounds, pickup as an
   * ISO date, everything else as a trimmed string.
   */
  readonly value: string | number | null;
}

export const VERDICTS = ["supported", "unsupported", "ambiguous"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface CheckedClaim {
  readonly claim: Claim;
  readonly verdict: Verdict;
  readonly reason: string;
}

/**
 * What the message is allowed to assert: the load record plus the amounts the
 * policy engine actually approved.
 */
export interface GroundTruth {
  readonly loadId: string;
  readonly origin: string;
  readonly destination: string;
  readonly equipment: string;
  readonly weightLbs: number;
  readonly commodity: string;
  readonly pickupAt: Date;
  readonly carrierName: string;
  /** Every money amount that came from a validated decision, in cents. */
  readonly approvedAmountsCents: readonly number[];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Equipment is written for humans in messages but stored as a slug. */
const EQUIPMENT_SYNONYMS: Record<string, readonly string[]> = {
  dry_van: ["dry van", "van", "dryvan"],
  reefer: ["reefer", "refrigerated", "temp controlled", "temperature controlled"],
  flatbed: ["flatbed", "flat bed", "open deck"],
  specialized: ["specialized", "specialised", "step deck", "oversize"],
};

export function verifyClaim(claim: Claim, truth: GroundTruth): CheckedClaim {
  const mark = (verdict: Verdict, reason: string): CheckedClaim => ({ claim, verdict, reason });

  // A claim the extractor could not pin to a value is not evidence of anything.
  // Counting it either way would be inventing a result.
  if (claim.value === null) {
    return mark("ambiguous", "no checkable value was extracted");
  }

  switch (claim.kind) {
    case "money": {
      if (typeof claim.value !== "number") return mark("ambiguous", "amount was not numeric");
      return truth.approvedAmountsCents.includes(claim.value)
        ? mark("supported", "matches an amount the policy engine approved")
        : mark(
            "unsupported",
            `no approved amount equals ${claim.value} cents (approved: ${truth.approvedAmountsCents.join(", ")})`,
          );
    }

    case "weight": {
      if (typeof claim.value !== "number") return mark("ambiguous", "weight was not numeric");
      return claim.value === truth.weightLbs
        ? mark("supported", "matches the load record")
        : mark("unsupported", `load weighs ${truth.weightLbs} lbs, message says ${claim.value}`);
    }

    case "pickup": {
      const claimed = new Date(String(claim.value));
      if (Number.isNaN(claimed.getTime())) return mark("ambiguous", "pickup was not a parsable date");
      // To the minute: a message saying 08:00 for an 08:00 pickup is accurate
      // even though the stored value carries seconds.
      const sameMinute =
        Math.abs(claimed.getTime() - truth.pickupAt.getTime()) < 60_000;
      return sameMinute
        ? mark("supported", "matches the load's pickup time")
        : mark(
            "unsupported",
            `pickup is ${truth.pickupAt.toISOString()}, message says ${claimed.toISOString()}`,
          );
    }

    case "equipment": {
      const claimed = normalise(String(claim.value));
      const accepted = EQUIPMENT_SYNONYMS[truth.equipment] ?? [truth.equipment];
      return accepted.some((a) => claimed.includes(normalise(a)))
        ? mark("supported", "matches the load's equipment")
        : mark("unsupported", `load is ${truth.equipment}, message says '${claim.value}'`);
    }

    case "commodity":
      return normalise(String(claim.value)) === normalise(truth.commodity)
        ? mark("supported", "matches the load record")
        : mark("unsupported", `commodity is '${truth.commodity}', message says '${claim.value}'`);

    case "origin":
      return normalise(String(claim.value)) === normalise(truth.origin)
        ? mark("supported", "matches the load record")
        : mark("unsupported", `origin is '${truth.origin}', message says '${claim.value}'`);

    case "destination":
      return normalise(String(claim.value)) === normalise(truth.destination)
        ? mark("supported", "matches the load record")
        : mark("unsupported", `destination is '${truth.destination}', message says '${claim.value}'`);

    case "load_id":
      return normalise(String(claim.value)) === normalise(truth.loadId)
        ? mark("supported", "matches the load record")
        : mark("unsupported", `load is ${truth.loadId}, message says '${claim.value}'`);

    case "carrier":
      return normalise(String(claim.value)) === normalise(truth.carrierName)
        ? mark("supported", "matches the carrier on this negotiation")
        : mark("unsupported", `carrier is '${truth.carrierName}', message says '${claim.value}'`);

    case "other":
      // Deliberately not judged. "We will move quickly" is not checkable
      // against a load row, and guessing at it is how an evaluator starts
      // producing numbers that cannot be defended.
      return mark("ambiguous", "not a claim the load record can settle");
  }
}

export interface HallucinationScore {
  readonly checked: readonly CheckedClaim[];
  readonly supported: number;
  readonly unsupported: number;
  readonly ambiguous: number;
  /**
   * unsupported / (supported + unsupported).
   *
   * Ambiguous claims are excluded rather than counted as either. Counting them
   * as supported would flatter the number; counting them as hallucinations
   * would punish the agent for sentences the load record simply has no opinion
   * about. Excluding them means the denominator is only claims that could
   * actually be settled, and the count is reported alongside so a run where
   * most claims were unsettleable is visible rather than hidden.
   */
  readonly rate: number;
}

export function scoreHallucination(
  claims: readonly Claim[],
  truth: GroundTruth,
): HallucinationScore {
  const checked = claims.map((c) => verifyClaim(c, truth));
  const supported = checked.filter((c) => c.verdict === "supported").length;
  const unsupported = checked.filter((c) => c.verdict === "unsupported").length;
  const ambiguous = checked.filter((c) => c.verdict === "ambiguous").length;
  const settleable = supported + unsupported;
  return {
    checked,
    supported,
    unsupported,
    ambiguous,
    rate: settleable === 0 ? 0 : unsupported / settleable,
  };
}
