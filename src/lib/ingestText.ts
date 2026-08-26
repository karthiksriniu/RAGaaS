import { chunkHtmlByHeadings } from "@/lib/chunk";
import { embedTexts } from "@/lib/embeddings";
import { withTenant } from "@/lib/db";
import { markdownToSimpleHtml } from "@/lib/markdownHtml";

// Ingests plain markdown/text into a tenant's knowledge base, reusing the same
// chunk -> embed -> store path as the .docx upload so generated and uploaded
// sources are indistinguishable downstream. Extracted rather than duplicated
// inside the signup flow: the two must stay in step, or answers would differ
// depending on how the content arrived.

export interface IngestResult {
  sourceUri: string;
  chunksIngested: number;
}

/** Replaces any existing content for `sourceUri` so re-ingesting is idempotent
 * rather than duplicating. sourceType marks where it came from, so generated
 * content stays distinguishable from what the business uploaded. */
export async function ingestText(
  tenantId: string,
  sourceUri: string,
  markdown: string,
  sourceType = "generated"
): Promise<IngestResult> {
  const chunks = chunkHtmlByHeadings(markdownToSimpleHtml(markdown));
  if (chunks.length === 0) return { sourceUri, chunksIngested: 0 };

  const embeddings = await embedTexts(
    chunks.map((c) => c.text),
    "document"
  );

  await withTenant(tenantId, async (client) => {
    await client.query("DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2", [
      tenantId,
      sourceUri,
    ]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO chunks (tenant_id, text, source_type, source_uri, page_or_row, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, chunks[i].text, sourceType, sourceUri, chunks[i].heading, `[${embeddings[i].join(",")}]`]
      );
    }
  });

  return { sourceUri, chunksIngested: chunks.length };
}
