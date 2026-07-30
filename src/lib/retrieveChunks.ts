import { embedTexts } from "@/lib/embeddings";
import { withTenant } from "@/lib/db";
import type { RetrievedChunk } from "@/lib/contextBlock";

// The retrieval half of the RAG pipeline, split out of answerQuestion.ts so
// it can be reused by paths that need a tenant's matching KB content without
// generating an answer - notably the voice path, where the answer is composed
// by a different engine (see Phase 5 of the plan). answerQuestion.ts imports
// this back, so the text path is unchanged.
//
// The chunk shape and the context-block formatter live in contextBlock.ts
// rather than here: this module imports @/lib/db, which throws at module load
// without SUPABASE_DB_URL_APP, and that would make them un-unit-testable.
// Re-exported below so callers needing both can import from one place.

export type { RetrievedChunk };
export { buildContextBlock } from "@/lib/contextBlock";

/** Matches the previous inline query's LIMIT. Callers can override, but the
 * default is what the answer-mode similarity thresholds in answerMode.ts were
 * tuned against, so changing it per-caller affects answer quality, not just
 * cost. */
export const DEFAULT_RETRIEVAL_LIMIT = 6;

/** Embeds the question and returns the tenant's closest-matching chunks,
 * ordered most-similar first. Scoped by withTenant(), so RLS is the backstop
 * under the explicit tenant_id filter - the same two-layer guarantee the rest
 * of the app relies on. */
export async function retrieveChunks(
  question: string,
  tenantId: string,
  limit: number = DEFAULT_RETRIEVAL_LIMIT
): Promise<RetrievedChunk[]> {
  if (!tenantId) throw new Error("retrieveChunks: tenantId is required");

  const [queryEmbedding] = await embedTexts([question], "query");
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  const result = await withTenant(tenantId, (client) =>
    client.query<RetrievedChunk>(
      `SELECT text, source_type, source_uri, page_or_row, 1 - (embedding <=> $1) as similarity
       FROM chunks
       WHERE tenant_id = $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [embeddingLiteral, tenantId, limit]
    )
  );

  return result.rows;
}
