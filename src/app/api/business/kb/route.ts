import { NextRequest, NextResponse } from "next/server";
import { chunkHtmlByHeadings } from "@/lib/chunk";
import { embedTexts } from "@/lib/embeddings";
import { withTenant } from "@/lib/db";
import { businessTenantId } from "@/lib/businessAuth";
import {
  extractDocument,
  extensionOf,
  SUPPORTED_EXTENSIONS,
  UnsupportedFileTypeError,
} from "@/lib/extractDocument";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

// Generous for a policy document or price list, small enough that the bytes
// are comfortable in Postgres. See the kb_files comment in schema.sql for when
// this should move to object storage instead.
const MAX_UPLOAD_BYTES = 10_000_000;

// The business's own knowledge sources. Same ingest path as the platform-admin
// route, but the tenant comes from the session cookie rather than the request,
// so a business can only ever touch its own content.

export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await withTenant(tenantId, (client) =>
    client.query(
      `SELECT c.source_uri, c.source_type, count(*)::int AS chunk_count,
              max(c.ingested_at) AS ingested_at,
              (f.source_uri IS NOT NULL) AS downloadable,
              f.size_bytes
         FROM chunks c
         LEFT JOIN kb_files f
           ON f.tenant_id = c.tenant_id AND f.source_uri = c.source_uri
        WHERE c.tenant_id = $1
        GROUP BY c.source_uri, c.source_type, f.source_uri, f.size_bytes
        ORDER BY max(c.ingested_at) DESC`,
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

  if (!SUPPORTED_EXTENSIONS.includes(extensionOf(file.name) as never)) {
    return NextResponse.json(
      { error: `Upload a Word document (.docx), a PDF (.pdf), or an Excel spreadsheet (.xlsx).` },
      { status: 400 }
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `That file is ${Math.round(file.size / 1_000_000)}MB. The limit is ${MAX_UPLOAD_BYTES / 1_000_000}MB.` },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let doc;
  try {
    doc = await extractDocument(file.name, buffer);
  } catch (err) {
    if (err instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(`extraction failed for ${file.name}:`, err);
    return NextResponse.json(
      { error: "We couldn't read that file. It may be password-protected or corrupted." },
      { status: 400 }
    );
  }

  const chunks = chunkHtmlByHeadings(doc.html);
  if (chunks.length === 0) {
    return NextResponse.json(
      {
        error:
          "No text could be read from this file. If it's a scanned PDF, the pages are images " +
          "rather than text - re-save it with selectable text, or upload a Word version.",
      },
      { status: 400 }
    );
  }

  const embeddings = await embedTexts(chunks.map((c) => c.text), "document");

  await withTenant(tenantId, async (client) => {
    await client.query("DELETE FROM chunks WHERE tenant_id = $1 AND source_uri = $2", [tenantId, file.name]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO chunks (tenant_id, text, source_type, source_uri, page_or_row, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, chunks[i].text, doc.sourceType, file.name, chunks[i].heading, `[${embeddings[i].join(",")}]`]
      );
    }
  });

  // Kept so the business can download back exactly what it uploaded. Stored
  // after the chunks so a file that failed to ingest never appears as
  // downloadable, and upserted so re-uploading the same name replaces it
  // rather than leaving the old bytes behind the new chunks.
  await pool.query(
    `INSERT INTO kb_files (tenant_id, source_uri, mime_type, size_bytes, content, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, source_uri) DO UPDATE
       SET mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
           content = excluded.content, uploaded_at = now()`,
    [tenantId, file.name, doc.mimeType, buffer.length, buffer]
  );

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
  // The stored original goes with it - otherwise a deleted source stays
  // downloadable and the business's file lives on after they removed it.
  await pool.query("DELETE FROM kb_files WHERE tenant_id = $1 AND source_uri = $2", [tenantId, sourceUri]);
  return NextResponse.json({ ok: true });
}
