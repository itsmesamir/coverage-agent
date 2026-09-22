/**
 * Deterministic reranking: the first stage's top 50 down to the 5 we would actually call.
 *
 * Pure. No database, no model, no clock: recency arrives already computed as
 * `lastRunDaysAgo` rather than this module reading the current date itself,
 * the same injected-time discipline the policy engine uses.
 *
 * Why a second stage at all. The first stage is a *recall* device: it casts a
 * wide, cheap, semantic net over 200 carriers and is happy to be approximately
 * right. It is bad at exactly the things that decide a real booking -- an
 * embedding cannot tell you that 92.6% on-time beats 85.6%, or that $1,787 is
 * below market, because those are arithmetic comparisons and embeddings encode
 * numbers as weak text. So stage one finds plausible carriers semantically and
 * stage two ranks them arithmetically on structured fields.
 *
 * Hard filters vs scored signals. Authority and equipment compatibility are
 * filters, not weights: no amount of lane familiarity makes a revoked carrier
 * bookable, and the policy engine would refuse the booking anyway. Ranking a
 * carrier we cannot book wastes a slot. Equipment that is merely a *substitute*
 * (a reefer on dry freight) is legal but wasteful, so that is a score penalty,
 * exactly as decided in DECISIONS.md.
 */

import { isTypePermitted, isWithinCapacity, matchQuality } from "../domain/equipment.js";
import type { Equipment } from "../domain/equipment.js";

/** Loads on a lane beyond which more history tells us nothing new. */
export const FAMILIARITY_SATURATION_LOADS = 20;
/** A lane run longer ago than this contributes no recency credit. */
export const RECENCY_HORIZON_DAYS = 180;
/** Rate advantage is clipped to +/- this fraction of market before scoring. */
export const RATE_ADVANTAGE_CLIP = 0.15;

/**
 * Weights sum to 1 so `score` is directly readable as "fraction of the best
 * possible carrier". Ordering is unaffected by the normalisation, but being
 * able to say "0.72" and have it mean something is worth the constraint.
 */
export const WEIGHTS = {
  laneFamiliarity: 0.3,
  onTime: 0.25,
  rateAdvantage: 0.2,
  equipmentMatch: 0.15,
  recency: 0.1,
} as const;

export interface RerankCandidate {
  readonly carrierId: string;
  readonly authorityActive: boolean;
  readonly equipment: readonly Equipment[];
  readonly onTimeBps: number;
  /** Lane history for THIS lane only. Absent when the carrier has never run it. */
  readonly laneLoadsRun?: number | undefined;
  readonly laneLastRateCents?: number | undefined;
  readonly laneLastRunDaysAgo?: number | undefined;
}

export interface RerankContext {
  readonly requiredEquipment: Equipment;
  readonly weightLbs: number;
  /** Mid-market linehaul for the lane. The centre rate advantage is measured from. */
  readonly marketRateCents: number;
}

export interface ScoreBreakdown {
  readonly laneFamiliarity: number;
  readonly onTime: number;
  readonly rateAdvantage: number;
  readonly equipmentMatch: number;
  readonly recency: number;
}

export interface RankedCarrier {
  readonly carrierId: string;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  /** The trailer we would actually put on this load. */
  readonly trailer: Equipment;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The trailer this carrier would use: the best-matching one it owns that is
 * both type-permitted and heavy enough. Undefined means we cannot book them.
 */
export function usableTrailer(
  candidate: RerankCandidate,
  context: RerankContext,
): Equipment | undefined {
  const usable = candidate.equipment.filter(
    (e) =>
      isTypePermitted(context.requiredEquipment, e) && isWithinCapacity(e, context.weightLbs),
  );
  // Prefer an exact match over a substitute, then a stable alphabetical order
  // so the choice never depends on array ordering from the database.
  return [...usable].sort((a, b) => {
    const rank = (e: Equipment) => (matchQuality(context.requiredEquipment, e) === "exact" ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  })[0];
}

export function isBookable(candidate: RerankCandidate, context: RerankContext): boolean {
  return candidate.authorityActive && usableTrailer(candidate, context) !== undefined;
}

export function scoreBreakdown(
  candidate: RerankCandidate,
  context: RerankContext,
  trailer: Equipment,
): ScoreBreakdown {
  const loads = candidate.laneLoadsRun ?? 0;

  // Deep history on the lane. Saturating rather than linear: the difference
  // between 1 and 10 loads is meaningful, between 40 and 50 it is not.
  const laneFamiliarity = clamp01(loads / FAMILIARITY_SATURATION_LOADS);

  // 80% on-time scores 0, 99% scores 1. Below 80% is a carrier we would not
  // call regardless of price, so the floor is not worth resolving.
  const onTime = clamp01((candidate.onTimeBps - 8000) / 1900);

  // How far below mid-market this carrier last ran the lane. No history means
  // no evidence, which scores neutral rather than zero -- an unknown carrier
  // should not be punished as if they had quoted high.
  const rateAdvantage =
    candidate.laneLastRateCents === undefined || context.marketRateCents <= 0
      ? 0.5
      : clamp01(
          (clampTo(
            (context.marketRateCents - candidate.laneLastRateCents) / context.marketRateCents,
            -RATE_ADVANTAGE_CLIP,
            RATE_ADVANTAGE_CLIP,
          ) +
            RATE_ADVANTAGE_CLIP) /
            (2 * RATE_ADVANTAGE_CLIP),
        );

  const equipmentMatch = matchQuality(context.requiredEquipment, trailer) === "exact" ? 1 : 0.5;

  const recency =
    candidate.laneLastRunDaysAgo === undefined
      ? 0
      : clamp01(1 - candidate.laneLastRunDaysAgo / RECENCY_HORIZON_DAYS);

  return { laneFamiliarity, onTime, rateAdvantage, equipmentMatch, recency };
}

export function score(breakdown: ScoreBreakdown): number {
  return (
    breakdown.laneFamiliarity * WEIGHTS.laneFamiliarity +
    breakdown.onTime * WEIGHTS.onTime +
    breakdown.rateAdvantage * WEIGHTS.rateAdvantage +
    breakdown.equipmentMatch * WEIGHTS.equipmentMatch +
    breakdown.recency * WEIGHTS.recency
  );
}

/**
 * Filter to bookable carriers, score them, return the best `limit`.
 *
 * Ties break on carrierId so the output is a total order: the same input always
 * produces the same list, which is what lets precision@5 be a stable metric
 * rather than a coin flip between equal-scoring carriers.
 */
export function rerank(
  candidates: readonly RerankCandidate[],
  context: RerankContext,
  limit = 5,
): RankedCarrier[] {
  const ranked: RankedCarrier[] = [];

  for (const candidate of candidates) {
    const trailer = usableTrailer(candidate, context);
    if (!candidate.authorityActive || trailer === undefined) continue;
    const breakdown = scoreBreakdown(candidate, context, trailer);
    ranked.push({ carrierId: candidate.carrierId, score: score(breakdown), breakdown, trailer });
  }

  ranked.sort((a, b) => b.score - a.score || a.carrierId.localeCompare(b.carrierId));
  return ranked.slice(0, limit);
}

function clampTo(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
