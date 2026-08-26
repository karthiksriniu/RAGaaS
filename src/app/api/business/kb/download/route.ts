import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { businessTenantId } from "@/lib/businessAuth";

export const runtime = "nodejs";

// Serves back the original file a business uploaded.
//
// Scoped by the tenant in the session cookie and never by anything in the
// request, so a business cannot read another's documents by guessing a
// filename - the tenant is part of the primary key, so a mismatched pair
// simply finds nothing.

export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sourceUri = req.nextUrl.searchParams.get("sourceUri");
  if (!sourceUri) {
    return NextResponse.json({ error: "sourceUri is required" }, { status: 400 });
  }

  const res = await pool.query<{ mime_type: string; content: Buffer; size_bytes: number }>(
    "SELECT mime_type, content, size_bytes FROM kb_files WHERE tenant_id = $1 AND source_uri = $2",
    [tenantId, sourceUri]
  );
  const row = res.rows[0];
  if (!row) {
    // Also the answer for sources ingested before originals were kept, and for
    // the auto-generated starter document, which was never a file.
    return NextResponse.json(
      { error: "No stored file for this source. Only uploaded documents can be downloaded." },
      { status: 404 }
    );
  }

  // Quote the filename and strip anything that could break out of the header:
  // the name is business-supplied, and a raw quote or newline here is a
  // response-splitting bug rather than a cosmetic one.
  const safeName = sourceUri.replace(/[\r\n"\\]/g, "_");

  return new NextResponse(new Uint8Array(row.content), {
    status: 200,
    headers: {
      "Content-Type": row.mime_type,
      "Content-Length": String(row.size_bytes),
      "Content-Disposition": `attachment; filename="${safeName}"`,
      // These are a tenant's private documents; no shared cache should hold them.
      "Cache-Control": "private, no-store",
    },
  });
}
