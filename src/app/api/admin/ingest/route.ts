import { NextRequest, NextResponse } from "next/server";
import mammoth from "mammoth";
import { chunkHtmlByHeadings } from "@/lib/chunk";
import { embedTexts } from "@/lib/embeddings";
import { withTenant } from "@/lib/db";
import { isAdminSession } from "@/lib/adminAuth";
import { assertTenantExists, TenantNotFoundError } from "@/lib/tenants";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const tenantId = formData.get("tenantId") as string | null;

    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }
    await assertTenantExists(tenantId);

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

    await withTenant(tenantId, async (client) => {
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
    });

    return NextResponse.json({
      ok: true,
      sourceUri: file.name,
      chunksIngested: chunks.length,
    });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("/api/admin/ingest POST failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }
  try {
    await assertTenantExists(tenantId);
    const result = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT source_uri, source_type, count(*)::int as chunk_count, max(ingested_at) as ingested_at
         FROM chunks
         WHERE tenant_id = $1
         GROUP BY source_uri, source_type
         ORDER BY max(ingested_at) DESC`,
        [tenantId]
      )
    );
    return NextResponse.json({ sources: result.rows });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sourceUri, tenantId } = await req.json();
  if (!sourceUri) {
    return NextResponse.json({ error: "sourceUri is required" }, { status: 400 });
  }
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }
  try {
    await assertTenantExists(tenantId);
    await withTenant(tenantId, (client) =>
      client.query("DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2", [
        tenantId,
        sourceUri,
      ])
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
