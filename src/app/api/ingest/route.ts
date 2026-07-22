import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import { chunkHtmlByHeadings } from "@/lib/chunk";
import { embedTexts } from "@/lib/embeddings";
import { pool } from "@/lib/db";

export const runtime = "nodejs";

function defaultTenant() {
  return process.env.DEFAULT_TENANT_ID || "default";
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const tenantId = (formData.get("tenantId") as string) || defaultTenant();

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".docx")) {
      return NextResponse.json(
        { error: "Only .docx files are supported in Phase 1" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { value: html } = await mammoth.convertToHtml({ buffer });
    const chunks = chunkHtmlByHeadings(html);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "No content could be extracted from this document" },
        { status: 400 }
      );
    }

    const embeddings = await embedTexts(
      chunks.map((c) => c.text),
      "document"
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2",
        [tenantId, file.name]
      );
      for (let i = 0; i < chunks.length; i++) {
        const embeddingLiteral = `[${embeddings[i].join(",")}]`;
        await client.query(
          `INSERT INTO chunks (tenant_id, text, source_type, source_uri, page_or_row, embedding)
           VALUES ($1, $2, 'docx', $3, $4, $5)`,
          [tenantId, chunks[i].text, file.name, chunks[i].heading, embeddingLiteral]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return NextResponse.json({
      ok: true,
      sourceUri: file.name,
      chunksIngested: chunks.length,
    });
  } catch (err) {
    console.error("/api/ingest POST failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get("tenantId") || defaultTenant();
  const result = await pool.query(
    `SELECT source_uri, source_type, count(*)::int as chunk_count, max(ingested_at) as ingested_at
     FROM chunks
     WHERE tenant_id = $1
     GROUP BY source_uri, source_type
     ORDER BY max(ingested_at) DESC`,
    [tenantId]
  );
  return NextResponse.json({ sources: result.rows });
}

export async function DELETE(req: NextRequest) {
  const { sourceUri, tenantId } = await req.json();
  if (!sourceUri) {
    return NextResponse.json({ error: "sourceUri is required" }, { status: 400 });
  }
  await pool.query("DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2", [
    tenantId || defaultTenant(),
    sourceUri,
  ]);
  return NextResponse.json({ ok: true });
}
