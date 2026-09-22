/**
 * Local embeddings via transformers.js (ONNX). No embedding API.
 *
 * bge-small-en-v1.5: 384 dimensions, ~130MB of weights downloaded once to the
 * transformers.js cache on first use. Running locally is a deliberate cost and
 * privacy choice -- embedding 200 carrier profiles against a hosted API would
 * be cheap, but embedding every load query at negotiation time would not, and
 * carrier profiles are business data we would rather not ship anywhere.
 *
 * The pipeline is loaded lazily and memoised: model construction is seconds,
 * inference is milliseconds, so the cost belongs once per process.
 *
 * Normalisation matters. We ask for normalised vectors so cosine similarity and
 * inner product agree, and so pgvector's `<=>` cosine distance is comparable
 * across rows. bge models are documented as asymmetric retrieval models
 * expecting a query prefix (see QUERY_PREFIX) -- not verified here with an
 * ablation, just followed as documented.
 */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = 384;

/** bge-small's documented retrieval prefix. Applied to queries, never to documents. */
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

export function loadExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", EMBEDDING_MODEL);
  return extractorPromise;
}

async function encode(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await loadExtractor();
  const output = await extractor([...texts], { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}

/** Embed carrier profiles. No prefix: these are the documents. */
export async function embedDocuments(texts: readonly string[]): Promise<number[][]> {
  return encode(texts);
}

/** Embed a load query. Prefixed, because bge is an asymmetric retrieval model. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await encode([`${QUERY_PREFIX}${text}`]);
  if (!vector) throw new Error("Embedding returned no vector");
  return vector;
}

/** Batched so a 200-carrier backfill does not build one enormous tensor. */
export async function embedDocumentsBatched(
  texts: readonly string[],
  batchSize = 32,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(...(await embedDocuments(texts.slice(i, i + batchSize))));
  }
  return out;
}
