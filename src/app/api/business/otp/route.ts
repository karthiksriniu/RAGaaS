import { NextRequest, NextResponse } from "next/server";
import { normalizeMobile, sendOtp } from "@/lib/businessAuth";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

/** Issues an OTP for signup or login. Same endpoint for both: the mobile is the
 * identity either way, and whether an account exists is decided at verify time
 * so this cannot be used to enumerate which numbers are registered. */
export async function POST(req: NextRequest) {
  const { mobile } = await req.json().catch(() => ({ mobile: "" }));
  const normalized = normalizeMobile(mobile || "");
  if (!normalized) {
    return NextResponse.json({ error: "Enter a valid 10-digit Indian mobile number" }, { status: 400 });
  }

  // Per-number, so one number cannot be used to spam OTPs at scale.
  if (!(await checkRateLimit(`otp:${normalized}`, 60 * 60 * 1000, 8))) {
    return NextResponse.json({ error: "Too many code requests. Try again later." }, { status: 429 });
  }

  const { devCode } = await sendOtp(normalized);
  return NextResponse.json({ ok: true, mobile: normalized, devCode });
}
