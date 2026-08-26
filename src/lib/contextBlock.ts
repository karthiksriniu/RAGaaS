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

/** Context for the VOICE path, where there are no citations.
 *
 * buildContextBlock() above prefixes every passage with "[1] (Source: file.docx
 * — heading)" because the text path parses those numbers back out to build its
 * citation list. Feeding that to a voice agent is actively harmful: its prompt
 * forbids naming sources and speaking bracketed numbers, so it receives content
 * composed entirely of things it is told never to use, with nothing marking it
 * as data to answer from - and reasonably concludes it cannot use it, then
 * tells the caller there is no information. Observed doing exactly that.
 *
 * So: passages only. The chunker already puts each section's heading on the
 * first line, which is useful grounding without being a "source". */
export function buildVoiceContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n\n- - -\n\n");
}
