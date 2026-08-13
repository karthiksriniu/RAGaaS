import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import {
  BUSINESS_SESSION_COOKIE,
  createBusinessSession,
  normalizeMobile,
  verifyOtp,
} from "@/lib/businessAuth";

export const runtime = "nodejs";

/** Verifies an OTP. If the number already owns a tenant, logs straight in.
 * Otherwise reports that signup should continue - the tenant is not created
 * here, because it must not exist until the business has been through the plan
 * step. */
export async function POST(req: NextRequest) {
  const { mobile, code } = await req.json().catch(() => ({}));
  const normalized = normalizeMobile(mobile || "");
  if (!normalized || !code) {
    return NextResponse.json({ error: "Mobile number and code are required" }, { status: 400 });
  }

  const result = await verifyOtp(normalized, String(code));
  if (result !== "ok") {
    const message =
      result === "expired" ? "That code has expired. Request a new one."
      : result === "too_many_attempts" ? "Too many incorrect attempts. Request a new code."
      : result === "not_found" ? "Request a code first."
      : "That code isn't right.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const existing = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM business_accounts WHERE mobile = $1",
    [normalized]
  );

  if (existing.rows.length > 0) {
    const tenantId = existing.rows[0].tenant_id;
    const res = NextResponse.json({ ok: true, existing: true, tenantId });
    res.cookies.set(BUSINESS_SESSION_COOKIE, createBusinessSession(tenantId), {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  // Verified, but no account yet - the caller continues to the plan step.
  return NextResponse.json({ ok: true, existing: false, mobile: normalized });
}
