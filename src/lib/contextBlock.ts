// The pure, dependency-free half of retrieval: the chunk shape and the
// context-block formatter. Deliberately has no imports - retrieveChunks.ts
// pulls in @/lib/db, which throws at module load when SUPABASE_DB_URL_APP is
// unset (true in the unit-test environment by design), so anything that needs
// to stay unit-testable lives here. Same reasoning as systemPrompt.ts,
// tenantHost.ts and whatsappFormatting.ts.

export interface RetrievedChunk {
  text: string;
  source_type: string;
  source_uri: string;
  page_or_row: string | null;
  similarity: number;
}

/** Formats chunks into the numbered context block the system prompt cites
 * against. The bracketed indices produced here are exactly what [1], [2] in a
 * generated answer refer to, and answerQuestion.ts filters its citation list
 * by parsing those same numbers back out - so this 1-based numbering is a
 * contract between the two, not a display detail. */
export function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] (Source: ${c.source_uri}${c.page_or_row ? ` — ${c.page_or_row}` : ""})\n${c.text}`
    )
    .join("\n\n---\n\n");
}
