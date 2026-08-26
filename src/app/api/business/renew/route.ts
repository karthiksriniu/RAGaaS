import { NextRequest, NextResponse } from "next/server";
import { businessTenantId } from "@/lib/businessAuth";
import { getOrder, setOrderLicensedUntil } from "@/lib/billing";
import { assertTenantExists, grantLicense } from "@/lib/tenants";
import { licenseKindFor } from "@/lib/upi";

export const runtime = "nodejs";

/** Finishes a renewal: extends the licence, and NOTHING else.
 *
 * This is the whole reason renewal is its own route rather than a second call
 * to /api/business/signup. Signup runs provisionTenant, which calls
 * acquireNumber - and on an environment with live procurement switched on that
 * BUYS a number. A renewing business already has one; buying it a second line
 * would spend real money and leave its customers dialling a number nobody
 * answers. Nothing here goes near provisioning.
 *
 * Idempotent. claimOrder and confirmOrder already grant the licence for a
 * renewal order (its tenant exists from the start, unlike a signup's), so in
 * the normal case this re-applies the same grant - and grantLicense only ever
 * moves an expiry outwards, so re-applying changes nothing. It matters when the
 * grant did not happen: a claim that raced a confirmation, or a browser that
 * came back to a paid order after an error. */
export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { orderId } = await req.json().catch(() => ({}));
  if (typeof orderId !== "string" || !orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  const order = await getOrder(orderId);
  // Scoped on the session's tenant, never on anything in the body - the same
  // rule every other business-facing route follows.
  if (!order || order.tenantId !== tenantId || order.purpose !== "renewal") {
    return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  }

  const kind = licenseKindFor(order.status);
  if (!kind) {
    return NextResponse.json({ error: "That payment hasn't gone through yet" }, { status: 409 });
  }

  const licensedUntil = await grantLicense(tenantId, kind, new Date(order.claimedAt || order.createdAt));
  await setOrderLicensedUntil(order.id, licensedUntil);
  const tenant = await assertTenantExists(tenantId);

  return NextResponse.json({
    ok: true,
    licenseExpiresAt: tenant.licenseExpiresAt,
    // 'provisional' until the credit is actually seen - the dashboard says so
    // rather than letting someone be surprised in three days.
    licenseState: kind === "full" ? "active" : "provisional",
    voicePhoneNumber: tenant.voicePhoneNumber,
  });
}
