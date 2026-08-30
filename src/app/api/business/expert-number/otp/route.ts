import { NextRequest, NextResponse } from "next/server";
import { businessTenantId, normalizeMobile, sendOtp, OtpUndeliverableError } from "@/lib/businessAuth";
import { configuredChannel } from "@/lib/otpDelivery";
import { assertTenantExists, TenantNotFoundError } from "@/lib/tenants";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;

/** Step one of changing where callers are transferred: ring the proposed number
 * and read it a code.
 *
 * Session-guarded, unlike /api/business/otp - only the business itself can
 * point its own transfers somewhere. That still does not make it safe to leave
 * uncapped: it places a real, billed phone call to a number typed by the
 * caller, so it carries the same shape of limits as the public OTP route and
 * shares that route's global ceiling, because they spend the same money. */
export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { mobile } = await req.json().catch(() => ({ mobile: "" }));
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

  // A transfer to the agent's own line would dial straight back into the agent
  // and hand the caller to the thing they just asked to escape.
  if (tenant.voicePhoneNumber && normalized === tenant.voicePhoneNumber) {
    return NextResponse.json(
      { error: "That is your agent's own number. Callers would be put back through to the agent." },
      { status: 400 }
    );
  }

  // Already the number in force. Verifying it again would ring somebody for no
  // reason and cost us the call.
  if (normalized === tenant.expertPhoneNumber) {
    return NextResponse.json({ ok: true, unchanged: true, mobile: normalized });
  }

  // Stops one person being rung repeatedly, even by a business acting alone.
  if (!(await checkRateLimit(`expert-otp:${normalized}`, HOUR_MS, 5))) {
    return NextResponse.json({ error: "Too many code requests for that number. Try again later." }, { status: 429 });
  }
  // Per tenant, which is the meaningful axis here: the session is the identity,
  // so rotating IPs does not buy a fresh budget.
  if (!(await checkRateLimit(`expert-otp-tenant:${tenantId}`, HOUR_MS, 10))) {
    return NextResponse.json({ error: "Too many code requests. Try again later." }, { status: 429 });
  }
  if (!(await checkRateLimit(`expert-otp-ip:${getClientIp(req)}`, HOUR_MS, 10))) {
    return NextResponse.json(
      { error: "Too many code requests from this connection. Try again later." },
      { status: 429 }
    );
  }
  // Deliberately the SAME bucket as signup's. It is one telephony bill, and a
  // circuit breaker that can be walked around by using a different endpoint is
  // not a circuit breaker.
  if (!(await checkRateLimit("otp-global", HOUR_MS, 200))) {
    console.error("[expert-otp] GLOBAL hourly cap hit - refusing new calls, check for abuse");
    return NextResponse.json(
      { error: "We can't send verification codes right now. Please try again shortly." },
      { status: 503 }
    );
  }

  try {
    const { devCode } = await sendOtp(normalized);
    return NextResponse.json({ ok: true, mobile: normalized, devCode, channel: configuredChannel() });
  } catch (err) {
    if (err instanceof OtpUndeliverableError) {
      console.error("[expert-otp] no delivery channel configured");
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
