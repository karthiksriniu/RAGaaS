import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { updateTenantLicense, TenantNotFoundError } from "@/lib/tenants";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const { licenseExpiresAt } = await req.json();
    if (
      licenseExpiresAt !== null &&
      licenseExpiresAt !== undefined &&
      isNaN(Date.parse(licenseExpiresAt))
    ) {
      return NextResponse.json({ error: "licenseExpiresAt must be a valid date" }, { status: 400 });
    }

    const tenant = await updateTenantLicense(id, licenseExpiresAt ?? null);
    return NextResponse.json({ tenant });
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("/api/admin/tenants/[id] PATCH failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
