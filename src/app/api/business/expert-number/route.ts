import { NextRequest, NextResponse } from "next/server";
import {
  businessTenantId,
  consumeVerification,
  normalizeMobile,
  verifyOtp,
  type OtpResult,
} from "@/lib/businessAuth";
import { assertTenantExists, updateTenantExpertNumber, TenantNotFoundError } from "@/lib/tenants";

export const runtime = "nodejs";

const OTP_MESSAGE: Record<Exclude<OtpResult, "ok">, string> = {
  invalid: "That code is not right. Check it and try again.",
  expired: "That code has expired. Ask for a new one.",
  too_many_attempts: "Too many wrong codes. Ask for a new one.",
  not_found: "Ask for a code first.",
};

/** Step two: the code checks out, so this number becomes the one callers are
 * transferred to.
 *
 * Takes effect on the next inbound call with nothing to restart -
 * /api/voice/session reads the tenant fresh every time a call arrives. */
export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { mobile, code } = await req.json().catch(() => ({ mobile: "", code: "" }));
  const normalized = normalizeMobile(mobile || "");
  if (!normalized) {
    return NextResponse.json({ error: "Enter a valid 10-digit Indian mobile number" }, { status: 400 });
  }

  let tenant;
  try {
    tenant = await assertTenantExists(tenantId);
  } catch (err) {
    if (err instanceof TenantNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }

  // Re-checked here rather than trusted from the OTP step. This is the endpoint
  // that writes, and it is reachable on its own.
  if (tenant.voicePhoneNumber && normalized === tenant.voicePhoneNumber) {
    return NextResponse.json(
      { error: "That is your agent's own number. Callers would be put back through to the agent." },
      { status: 400 }
    );
  }

  if (normalized === tenant.expertPhoneNumber) {
    return NextResponse.json({ ok: true, expertPhoneNumber: normalized, unchanged: true });
  }

  if (typeof code !== "string" || !code.trim()) {
    return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 });
  }

  const result = await verifyOtp(normalized, code.trim());
  if (result !== "ok") {
    return NextResponse.json({ error: OTP_MESSAGE[result] }, { status: 400 });
  }

  await updateTenantExpertNumber(tenantId, normalized);

  // Spend the receipt immediately. verifyOtp leaves a 30-minute "this number
  // was verified" marker behind, which signup and the payment endpoints also
  // read - so leaving it lying about would let a code issued for this purpose
  // satisfy a different one. The number is saved; the receipt has done its job.
  await consumeVerification(normalized);

  return NextResponse.json({ ok: true, expertPhoneNumber: normalized });
}
