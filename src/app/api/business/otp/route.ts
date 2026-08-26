import { NextRequest, NextResponse } from "next/server";
import { normalizeMobile, sendOtp, OtpUndeliverableError } from "@/lib/businessAuth";
import { configuredChannel, missingSettings } from "@/lib/otpDelivery";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;

/** Which channel this deployment will deliver on, without sending anything.
 *
 * Exists because the only other way to find out is to POST, and POSTing now
 * rings a real phone and spends real money. A misconfigured delivery channel
 * is invisible until someone tries to sign up, which is the worst possible
 * moment to discover it - so preflight checks this before a cutover.
 *
 * Deliberately returns the channel NAME only. It says nothing about which
 * credentials are set, and carries no secret. */
export async function GET() {
  const channel = configuredChannel();
  // Staging only: which settings each channel is still waiting on. Names, not
  // values. Diagnosing "configured but still reports none" across five
  // variables otherwise costs a redeploy per guess.
  const onStaging = (process.env.TENANT_ROOT_DOMAIN || "").startsWith("staging.");
  return NextResponse.json({
    channel,
    ...(onStaging
      ? {
          missing: missingSettings(),
          // The number that will show as caller ID. Not a secret - every
          // recipient sees it - and seeing the RESOLVED value is what turns
          // "it just fails" into an obvious typo.
          callerNumber: normalizeMobile(process.env.OTP_CALLER_NUMBER || "") ?? "INVALID OR UNSET",
        }
      : {}),
  });
}

/** Issues an OTP for signup or login. Same endpoint for both: the mobile is the
 * identity either way, and whether an account exists is decided at verify time
 * so this cannot be used to enumerate which numbers are registered. */
export async function POST(req: NextRequest) {
  const { mobile } = await req.json().catch(() => ({ mobile: "" }));
  const normalized = normalizeMobile(mobile || "");
  if (!normalized) {
    return NextResponse.json({ error: "Enter a valid 10-digit Indian mobile number" }, { status: 400 });
  }

  // Three limits, because this endpoint now PLACES A REAL PHONE CALL that we
  // pay for, from a public form, to any number the caller types. Before
  // delivery was wired up the only cost of abuse was a database row.
  //
  // Per-number stops one person being called over and over. On its own it
  // stops nothing else: a caller who rotates the destination gets a fresh
  // budget every time, so the per-number cap alone leaves us dialling
  // strangers at our own expense for as long as someone cares to script it.
  const tooManyForNumber = !(await checkRateLimit(`otp:${normalized}`, HOUR_MS, 8));
  if (tooManyForNumber) {
    return NextResponse.json({ error: "Too many code requests. Try again later." }, { status: 429 });
  }

  // Per-caller, which is what actually caps the rotate-the-destination attack.
  // Generous enough for a real person who mistypes their number twice and
  // retries.
  if (!(await checkRateLimit(`otp-ip:${getClientIp(req)}`, HOUR_MS, 10))) {
    return NextResponse.json(
      { error: "Too many code requests from this connection. Try again later." },
      { status: 429 }
    );
  }

  // A whole-platform ceiling, as a circuit breaker rather than a limit anyone
  // legitimate should ever meet. Per-IP limits do nothing against many IPs,
  // and the failure mode there is an unbounded telephony bill discovered days
  // later. Signups are counted in tens per day; a few hundred calls an hour
  // means something is wrong regardless of who is doing it.
  if (!(await checkRateLimit("otp-global", HOUR_MS, 200))) {
    console.error("[otp] GLOBAL hourly cap hit - refusing new calls, check for abuse");
    return NextResponse.json(
      { error: "We can't send verification codes right now. Please try again shortly." },
      { status: 503 }
    );
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
