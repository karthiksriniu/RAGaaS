import { NextRequest, NextResponse } from "next/server";
import { normalizeMobile, sendOtp, OtpUndeliverableError } from "@/lib/businessAuth";
import { configuredChannel } from "@/lib/otpDelivery";
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

  try {
    const { devCode } = await sendOtp(normalized);
    // The UI says "check WhatsApp" or "check your messages" based on this,
    // rather than guessing - being told the wrong app to look in is the
    // difference between waiting patiently and giving up.
    return NextResponse.json({ ok: true, mobile: normalized, devCode, channel: configuredChannel() });
  } catch (err) {
    if (err instanceof OtpUndeliverableError) {
      // Configuration fault, not the caller's. 503 so it is not mistaken for a
      // bad number, and loud in the logs so it cannot go unnoticed in prod.
      console.error("[otp] no delivery channel configured - set TWILIO_VERIFY_SERVICE_SID");
      return NextResponse.json(
        { error: "We can't send verification codes just yet. Please try again shortly." },
        { status: 503 }
      );
    }
    console.error("[otp] delivery failed:", err);
    return NextResponse.json(
      { error: "We couldn't send your code. Check the number and try again." },
      { status: 502 }
    );
  }
}
