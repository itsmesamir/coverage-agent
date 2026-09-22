/**
 * Equipment types, capacity, and compatibility.
 *
 * One authoritative definition, two consumers asking it different questions:
 *
 *   retrieval/  asks `matchQuality()`   -- a soft ranking signal
 *   policy/     asks `isTypePermitted()` and `isWithinCapacity()` -- hard gates
 *
 * Split deliberately into two rules rather than one matrix. Type compatibility
 * and weight capacity read different data and fail for different reasons, so
 * they get separate names and separate rejection messages: "load is 42,000
 * lbs, this trailer caps at 40,000" is more useful than "the matrix said no".
 *
 * Pure: no imports at all. Enforced by .dependency-cruiser.cjs (domain-no-external).
 */

export const EQUIPMENT_TYPES = ["dry_van", "reefer", "flatbed", "specialized"] as const;
export type Equipment = (typeof EQUIPMENT_TYPES)[number];

export const MATCH_QUALITIES = ["exact", "substitute", "blocked"] as const;
export type MatchQuality = (typeof MATCH_QUALITIES)[number];

/**
 * Maximum payload in pounds, by trailer type. A reefer carries less than a dry
 * van of the same length because the refrigeration unit and insulation weigh.
 *
 * `satisfies Record<Equipment, number>`: if a fifth equipment type is ever
 * added to EQUIPMENT_TYPES, this object literal fails to compile until a
 * capacity is given for it.
 */
export const CAPACITY_LBS = {
  dry_van: 45_000,
  reefer: 43_500,
  flatbed: 48_000,
  specialized: 45_000,
} as const satisfies Record<Equipment, number>;

/**
 * What a carrier may bring to a load, keyed by what the load requires.
 * Anything absent from a load's row is BLOCKED.
 */
const SUBSTITUTES: Record<Equipment, Partial<Record<Equipment, MatchQuality>>> = {
  // Dry freight in a box. A reefer is an insulated box -- it works, it just
  // costs more to run than the job needs.
  dry_van: { dry_van: "exact", reefer: "substitute" },
  // Temperature controlled. Nothing substitutes: a dry van has no reefer unit,
  // and the freight arrives spoiled.
  reefer: { reefer: "exact" },
  // Open deck. A step-deck/specialized trailer is an open deck too.
  flatbed: { flatbed: "exact", specialized: "substitute" },
  // Oversize or purpose-built. Nothing else has the deck height or securement.
  specialized: { specialized: "exact" },
};

/** Soft signal for ranking. Never throws; "blocked" is a legitimate answer. */
export function matchQuality(required: Equipment, offered: Equipment): MatchQuality {
  return SUBSTITUTES[required][offered] ?? "blocked";
}

/** Hard gate. True when the trailer type can legally and safely haul the load. */
export function isTypePermitted(required: Equipment, offered: Equipment): boolean {
  return matchQuality(required, offered) !== "blocked";
}

/** Hard gate, independent of type compatibility. */
export function isWithinCapacity(offered: Equipment, weightLbs: number): boolean {
  return weightLbs <= CAPACITY_LBS[offered];
}
