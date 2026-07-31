import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { isAdminSession } from "@/lib/adminAuth";
import { assertTenantExists, TenantNotFoundError, getTenantAnswerConfig } from "@/lib/tenants";
import { buildDerivedKb, type DerivedKbSource } from "@/lib/derivedKb";

export const runtime = "nodejs";

// Exports a tenant's whole knowledge base as the three artifacts a Sarvam
// voice agent needs (see src/lib/derivedKb.ts for why it's three, not one).
//
// This is an export, not a push: Sarvam has no knowledge-base API - confirmed
// by probing, where every KB-shaped path 404s while a real-but-undocumented
// route like /connections 500s instead - so the upload into Sarvam is a manual
// dashboard step. When Sarvam ships a KB API, only the delivery changes; the
// generation below stays as-is.
//
// Deliberately regenerates the COMPLETE document every time rather than
// emitting a delta. Sarvam's KB is a set of files with no per-chunk deletion,
// so appending deltas as extra files would leave superseded content
// retrievable alongside its replacement, with nothing to tell the model which
// is current. A full snapshot that replaces the file has no such failure mode.

interface ChunkRow {
  source_uri: string;
  source_type: string;
  text: string;
  page_or_row: string | null;
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
    // assertTenantExists returns the tenant row keyed by id, which is what we
    // want here - getTenant() resolves by subdomain and would miss whenever a
    // tenant's subdomain differs from its id.
    const tenant = await assertTenantExists(tenantId);

    const [answerConfigMd, result] = await Promise.all([
      getTenantAnswerConfig(tenantId),
      withTenant(tenantId, (client) =>
        client.query<ChunkRow>(
          `SELECT source_uri, source_type, text, page_or_row
           FROM chunks
           WHERE tenant_id = $1
           ORDER BY source_uri, id`,
          [tenantId]
        )
      ),
    ]);

    // Group by source while preserving the id ordering above, so each source's
    // chunks reassemble in the order they were ingested from the original file.
    const bySource = new Map<string, DerivedKbSource>();
    for (const row of result.rows) {
      let entry = bySource.get(row.source_uri);
      if (!entry) {
        entry = { source_uri: row.source_uri, source_type: row.source_type, chunks: [] };
        bySource.set(row.source_uri, entry);
      }
      entry.chunks.push({ text: row.text, page_or_row: row.page_or_row });
    }

    const artifacts = buildDerivedKb({
      tenantName: tenant.name,
      sources: [...bySource.values()],
      answerConfigMd,
    });

    const wantsFile = req.nextUrl.searchParams.get("download") === "1";
    if (wantsFile) {
      return new NextResponse(artifacts.document, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${tenantId}-knowledge-base.md"`,
        },
      });
    }

    return NextResponse.json(artifacts);
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
