import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { pool } from "@/lib/db";
import { businessTenantId } from "@/lib/businessAuth";
import { enhanceKbFromWebsite } from "@/lib/provisionTenant";

export const runtime = "nodejs";
export const maxDuration = 300;

// Re-reads the business's website and regenerates the starter knowledge base.
//
// Needed for two situations that were previously dead ends: the background read
// failed at signup and left the tenant on "failed" with no way to ask again,
// and content ingested by an older, broken build stays broken until something
// rewrites it - stored chunks do not repair themselves when the bug is fixed.
export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await pool.query<{
    name: string;
    business_description: string | null;
    website_url: string | null;
    kb_enhancement_status: string | null;
  }>(
    `SELECT name, business_description, website_url, kb_enhancement_status
       FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const tenant = row.rows[0];
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  if (!tenant.website_url) {
    return NextResponse.json(
      { error: "No website is saved for this business, so there is nothing to re-read." },
      { status: 400 }
    );
  }
  // Refuse to stack a second read on top of one already running: both would
  // write the same source and the slower would silently win.
  if (tenant.kb_enhancement_status === "pending") {
    return NextResponse.json({ ok: true, alreadyRunning: true });
  }

  await pool.query("UPDATE tenants SET kb_enhancement_status = 'pending' WHERE id = $1", [tenantId]);

  const { name, business_description: description, website_url: website } = tenant;
  after(async () => {
    await enhanceKbFromWebsite(tenantId, name, description || "", website);
  });

  return NextResponse.json({ ok: true, readingWebsite: website });
}
