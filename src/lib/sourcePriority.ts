import type { RetrievedChunk } from "@/lib/contextBlock";

// Ranks a business's OWN uploaded documents above the knowledge base we
// generated for them at signup.
//
// Generated content is written from the business's website by a model. It is
// useful on day one and while nothing has been uploaded, but it is inferred
// rather than authored, and it is bulky: one real tenant had ~6.7k characters
// of generated text against ~2k of uploaded documents, so it dominated
// retrieval on volume alone and answered questions the uploaded documents
// answered better.
//
// Dependency-free so it can be unit-tested: retrieveChunks.ts imports the
// database and throws at module load without a connection string.

/** How much similarity a generated chunk must beat an uploaded one by before
 * it is allowed to rank higher.
 *
 * A boost, not a hard rule. Observed similarities sit around 0.24-0.62 and the
 * gap between a good and a mediocre match is typically 0.05-0.15, so this size
 * lets uploaded content win ties and near-ties while a clearly better generated
 * answer still gets through - which matters for questions the uploaded
 * documents simply do not cover, like pricing. */
export const UPLOADED_SOURCE_BOOST = Number(process.env.UPLOADED_SOURCE_BOOST ?? 0.08);

/** Content we produced for the tenant rather than content they gave us. */
export const GENERATED_SOURCE_TYPE = "generated";

export function isUploaded(chunk: Pick<RetrievedChunk, "source_type">): boolean {
  return chunk.source_type !== GENERATED_SOURCE_TYPE;
}

/** Re-orders candidates so uploaded documents outrank generated content of
 * similar relevance, then trims to `limit`.
 *
 * The similarity on each chunk is left ALONE - only the ordering changes. The
 * no-match threshold is applied to the true similarity by the caller, so this
 * can never promote something that did not actually match into an answer. */
export function rankBySourcePriority(
  chunks: RetrievedChunk[],
  limit: number,
  boost: number = UPLOADED_SOURCE_BOOST
): RetrievedChunk[] {
  return [...chunks]
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => {
      const scoreA = a.chunk.similarity + (isUploaded(a.chunk) ? boost : 0);
      const scoreB = b.chunk.similarity + (isUploaded(b.chunk) ? boost : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      // Stable: equal scores keep the database's ordering rather than shuffling
      // between identical requests.
      return a.index - b.index;
    })
    .map(({ chunk }) => chunk)
    .slice(0, limit);
}
