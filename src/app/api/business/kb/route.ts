import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import { chunkHtmlByHeadings } from "@/lib/chunk";
import { embedTexts } from "@/lib/embeddings";
import { withTenant } from "@/lib/db";
import { businessTenantId } from "@/lib/businessAuth";

export const runtime = "nodejs";
export const maxDuration = 120;

// The business's own knowledge sources. Same ingest path as the platform-admin
// route, but the tenant comes from the session cookie rather than the request,
// so a business can only ever touch its own content.

export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await withTenant(tenantId, (client) =>
    client.query(
      `SELECT source_uri, source_type, count(*)::int AS chunk_count, max(ingested_at) AS ingested_at
       FROM chunks WHERE tenant_id = $1
       GROUP BY source_uri, source_type ORDER BY max(ingested_at) DESC`,
      [tenantId]
    )
  );
  return NextResponse.json({ sources: result.rows });
}

export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!file.name.toLowerCase().endsWith(".docx")) {
    return NextResponse.json({ error: "Only .docx files are supported" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const chunks = chunkHtmlByHeadings(html);
  if (chunks.length === 0) {
    return NextResponse.json({ error: "No content could be extracted from this document" }, { status: 400 });
  }

  const embeddings = await embedTexts(chunks.map((c) => c.text), "document");

  await withTenant(tenantId, async (client) => {
    await client.query("DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2", [tenantId, file.name]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO chunks (tenant_id, text, source_type, source_uri, page_or_row, embedding)
         VALUES ($1, $2, 'docx', $3, $4, $5)`,
        [tenantId, chunks[i].text, file.name, chunks[i].heading, `[${embeddings[i].join(",")}]`]
      );
    }
  });

  return NextResponse.json({ ok: true, sourceUri: file.name, chunksIngested: chunks.length });
}

export async function DELETE(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { sourceUri } = await req.json().catch(() => ({}));
  if (!sourceUri) return NextResponse.json({ error: "sourceUri is required" }, { status: 400 });

  await withTenant(tenantId, (client) =>
    client.query("DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2", [tenantId, sourceUri])
  );
  return NextResponse.json({ ok: true });
}
