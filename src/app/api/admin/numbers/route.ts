import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { assertTenantExists, TenantNotFoundError } from "@/lib/tenants";
import {
  addNumberToPool,
  assignNumberToTenant,
  listPool,
  releaseNumber,
  NumberNotInPoolError,
} from "@/lib/numberPool";

export const runtime = "nodejs";

// Admin control over which tenant answers on which of our numbers.
//
// Distinct from /api/admin/tenants/[id]/voice-number, which BUYS a number at
// the carrier. This one only moves numbers we already own between tenants,
// which is what the demo phase actually needs: two numbers, many prospects,
// and a need to point a line at whichever business is being shown today.

const E164 = /^\+[1-9]\d{7,14}$/;

/** GET — the pool, with whoever currently holds each number. */
export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ numbers: await listPool() });
}

/** POST — assign a number to a tenant, release it, or add one to the pool. */
export async function POST(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { e164?: string; tenantId?: string | null; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const e164 = typeof body.e164 === "string" ? body.e164.trim() : "";
  if (!E164.test(e164)) {
    return NextResponse.json(
      { error: "e164 must be in international format, e.g. +918071580725" },
      { status: 400 }
    );
  }

  try {
    if (body.action === "add") {
      await addNumberToPool(e164);
      return NextResponse.json({ ok: true, numbers: await listPool() });
    }

    if (body.action === "release" || !body.tenantId) {
      await releaseNumber(e164);
      return NextResponse.json({ ok: true, numbers: await listPool() });
    }

    // Fail before mutating anything if the tenant does not exist, rather than
    // stranding the number on an id nothing routes to.
    await assertTenantExists(body.tenantId);
    const result = await assignNumberToTenant(e164, body.tenantId);

    return NextResponse.json({
      ok: true,
      // Surfaced so the UI can say who lost their line, rather than the admin
      // discovering it when that business calls to complain.
      previousTenantId: result.previousTenantId,
      numbers: await listPool(),
    });
  } catch (err) {
    if (err instanceof NumberNotInPoolError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
