import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { businessTenantId } from "@/lib/businessAuth";
import { assertTenantExists, TenantNotFoundError, updateTenantAnswerConfig } from "@/lib/tenants";

export const runtime = "nodejs";

/** The signed-in business's own tenant. Everything is scoped by the tenant id
 * inside the session cookie - never by anything in the request - so a business
 * cannot read or write another's data by changing a payload field. */
export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tenant = await assertTenantExists(tenantId);
    const acct = await pool.query<{ mobile: string }>(
      "SELECT mobile FROM business_accounts WHERE tenant_id = $1",
      [tenantId]
    );
    const desc = await pool.query<{ business_description: string | null }>(
      "SELECT business_description FROM tenants WHERE id = $1",
      [tenantId]
    );
    return NextResponse.json({
      tenantId: tenant.id,
      businessName: tenant.name,
      subdomain: tenant.subdomain,
      mobile: acct.rows[0]?.mobile ?? null,
      description: desc.rows[0]?.business_description ?? null,
      voicePhoneNumber: tenant.voicePhoneNumber,
      answerConfigMd: tenant.answerConfigMd,
    });
  } catch (err) {
    if (err instanceof TenantNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}

/** Business name and answer style are editable. Mobile and tenant id are not,
 * per the product spec - the tenant id is in a live URL and every stored chunk. */
export async function PATCH(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  if (typeof body.businessName === "string") {
    const name = body.businessName.trim();
    if (name.length < 2 || name.length > 80) {
      return NextResponse.json({ error: "Business name must be 2-80 characters" }, { status: 400 });
    }
    await pool.query("UPDATE tenants SET name = $2 WHERE id = $1", [tenantId, name]);
  }

  if (body.answerConfigMd !== undefined) {
    const md = typeof body.answerConfigMd === "string" ? body.answerConfigMd.trim() : "";
    await updateTenantAnswerConfig(tenantId, md || null);
  }

  return NextResponse.json({ ok: true });
}
