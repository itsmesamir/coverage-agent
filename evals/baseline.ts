/**
 * Baseline comparison and the thresholds that fail a build.
 *
 * Thresholds come from CLAUDE.md and are asymmetric on purpose:
 *
 *   policy violations   any at all fails. This is the claim the whole design
 *                       rests on, and "slightly more than zero" is not a
 *                       weaker version of it -- it is the claim being false.
 *
 *   tool-call score     a drop of more than 0.02 below baseline fails. A band
 *                       rather than an exact match because the score moves
 *                       with model nondeterminism, and a check that fails on
 *                       noise gets disabled.
 *
 *   hallucination rate  a rise of more than 0.01 above baseline fails. Tighter
 *                       than the tool-call band because the metric reads 0 by
 *                       construction: any real movement is a structural change,
 *                       not noise.
 *
 * Improvements never fail. A build that breaks because the agent got better is
 * a build people learn to ignore.
 */

import type { FixtureScore } from "./score-fixture.js";

export interface Baseline {
  readonly recordedAt: string;
  readonly gitSha: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly corpus: {
    readonly traces: number;
    readonly decisionsChecked: number;
    readonly messagesWithClaims: number;
  };
  readonly metrics: {
    readonly policyViolations: number;
    readonly meanToolCallScore: number;
    readonly hallucinationRate: number;
  };
}

export const THRESHOLDS = {
  /** Any violation fails, regardless of baseline. */
  maxPolicyViolations: 0,
  /** How far the tool-call score may fall below baseline. */
  toolCallScoreDrop: 0.02,
  /** How far the hallucination rate may rise above baseline. */
  hallucinationRateRise: 0.01,
} as const;

/**
 * Thresholds are compared on values rounded to six decimals.
 *
 * Without it, a drop of exactly the documented limit fails: 1.0 - 0.98 is
 * 0.020000000000000018 in float, which is greater than 0.02. CLAUDE.md says
 * "drops MORE than 0.02", so exactly 0.02 has to pass, and a gate that fails
 * one ULP inside its own documented band is a gate nobody trusts.
 */
const PRECISION = 1e6;
function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

export interface Breach {
  readonly metric: string;
  readonly detail: string;
}

export interface Comparison {
  readonly breaches: readonly Breach[];
  readonly passed: boolean;
  readonly notes: readonly string[];
}

export function compareToBaseline(score: FixtureScore, baseline: Baseline): Comparison {
  const breaches: Breach[] = [];
  const notes: string[] = [];

  if (score.policyViolations > THRESHOLDS.maxPolicyViolations) {
    breaches.push({
      metric: "policy_violations",
      detail: `${score.policyViolations} violation(s); the target is zero by construction`,
    });
  }

  const toolDrop = round(baseline.metrics.meanToolCallScore - score.meanToolCallScore);
  if (toolDrop > THRESHOLDS.toolCallScoreDrop) {
    breaches.push({
      metric: "tool_call_score",
      detail:
        `${score.meanToolCallScore.toFixed(4)} against a baseline of ` +
        `${baseline.metrics.meanToolCallScore.toFixed(4)} ` +
        `(down ${toolDrop.toFixed(4)}, limit ${THRESHOLDS.toolCallScoreDrop})`,
    });
  }

  const hallucinationRise = round(score.hallucinationRate - baseline.metrics.hallucinationRate);
  if (hallucinationRise > THRESHOLDS.hallucinationRateRise) {
    breaches.push({
      metric: "hallucination_rate",
      detail:
        `${score.hallucinationRate.toFixed(4)} against a baseline of ` +
        `${baseline.metrics.hallucinationRate.toFixed(4)} ` +
        `(up ${hallucinationRise.toFixed(4)}, limit ${THRESHOLDS.hallucinationRateRise})`,
    });
  }

  // A corpus that shrank is not a pass. Deleting the traces that were failing
  // would otherwise read as a green build, which is the easiest way for a
  // regression check to be defeated by accident.
  if (score.traces < baseline.corpus.traces) {
    breaches.push({
      metric: "corpus_size",
      detail:
        `${score.traces} traces against a baseline of ${baseline.corpus.traces}; ` +
        `a smaller corpus cannot confirm the baseline`,
    });
  }

  if (score.decisionsChecked < baseline.corpus.decisionsChecked) {
    notes.push(
      `decisions checked fell from ${baseline.corpus.decisionsChecked} to ${score.decisionsChecked}`,
    );
  }
  if (score.messagesWithClaims < baseline.corpus.messagesWithClaims) {
    notes.push(
      `messages with cached claims fell from ${baseline.corpus.messagesWithClaims} ` +
        `to ${score.messagesWithClaims}; the hallucination rate covers less than it did`,
    );
  }
  if (toolDrop < 0) notes.push(`tool-call score improved by ${(-toolDrop).toFixed(4)}`);

  return { breaches, passed: breaches.length === 0, notes };
}
