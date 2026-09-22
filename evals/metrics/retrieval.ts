/**
 * Retrieval metrics: recall@k and precision@k.
 *
 * What these actually measure, stated plainly because it is easy to overclaim.
 *
 * The oracle is the reranker applied to the ENTIRE carrier population, not just
 * the 50 the first stage returned. So these numbers answer one question: **how
 * much does the candidate-generation cut cost us against exhaustive search?**
 *
 * Note precisely what that cut is today. There is no HNSW or IVFFlat index on
 * `carriers.embedding`, so `<=>` runs a sequential scan and an exact sort: the
 * first stage is exact KNN truncated to 50, not approximate nearest neighbour.
 * The recall we lose is therefore NOT approximation error -- it is the cost of
 * throwing away 150 of 200 carriers on a similarity measure that only partly
 * agrees with how the reranker scores them. Adding an ANN index at this size
 * would lower recall further while saving no measurable time.
 *
 * They do NOT measure whether the reranker's notion of a good carrier is
 * correct. That would be circular -- the reranker is both the thing under test
 * and the definition of the right answer. Judging the reranker itself needs
 * human labels, which this prototype does not have. Said out loud in the README
 * rather than quietly implied by a high number.
 *
 * recall@50  of the carriers exhaustive search considers relevant, what
 *            fraction did that stage surface? Recall lost here is unrecoverable: the
 *            reranker can only order what it was given.
 * precision@5 of the five we would actually call, how many are in the
 *            exhaustive top five? This is the number a broker feels.
 */

export function recallAtK(retrieved: readonly string[], relevant: readonly string[]): number {
  if (relevant.length === 0) return 1;
  const found = new Set(retrieved);
  return relevant.filter((id) => found.has(id)).length / relevant.length;
}

export function precisionAtK(
  ranked: readonly string[],
  idealTopK: readonly string[],
  k: number,
): number {
  if (k === 0) return 1;
  const ideal = new Set(idealTopK.slice(0, k));
  return ranked.slice(0, k).filter((id) => ideal.has(id)).length / k;
}

/** Rank-aware: rewards getting the best carrier first, not merely present. */
export function rankCorrelation(ranked: readonly string[], ideal: readonly string[]): number {
  const positions = new Map(ideal.map((id, i) => [id, i]));
  const pairs = ranked.map((id) => positions.get(id)).filter((p): p is number => p !== undefined);
  if (pairs.length < 2) return 1;

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      if (pairs[i]! < pairs[j]!) concordant += 1;
      else discordant += 1;
    }
  }
  return (concordant - discordant) / (concordant + discordant);
}
