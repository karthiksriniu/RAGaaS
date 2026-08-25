import { randomInt } from "crypto";
import twilio from "twilio";

// Delivering the signup/login code to the business owner.
//
// Built on Twilio Verify rather than a hand-rolled WhatsApp template send, for
// one decisive reason: a business-initiated WhatsApp message needs an
// authentication template APPROVED BY META, and Verify auto-creates and owns
// those templates. That removes an entire approval queue from the path to
// launch - the only thing left to get approved is the WhatsApp sender itself.
//
// It also means Twilio generates and checks the code, so no code of ours is
// ever stored or transmitted for this channel. See businessAuth.sendOtp for how
// that coexists with the local challenge row.
//
// WHY NOT SMS: Indian SMS requires DLT registration with TRAI - a sender ID and
// per-template approval that takes days to weeks. WhatsApp needs the sender
// approved by Meta but no template work, and every business owner signing up
// for this product already uses WhatsApp.

/** Verify's own default code TTL is 10 minutes, which matches the local
 * challenge row's expiry in businessAuth. Kept aligned deliberately: if Twilio
 * expired a code while our row still looked live, the owner would be told
 * "invalid code" for a code we had just accepted as current. */
export const DELIVERY_CODE_TTL_MS = 1000 * 60 * 10;

export type DeliveryChannel = "whatsapp" | "none";

function serviceSid(): string | null {
  return process.env.TWILIO_VERIFY_SERVICE_SID || null;
}

/** Which channel this environment can actually deliver on.
 *
 * "none" is a legitimate state for staging, where the code is shown on screen
 * instead. It is NEVER acceptable in production, and businessAuth refuses to
 * issue a code in that combination rather than creating a challenge nobody can
 * complete. */
export function configuredChannel(): DeliveryChannel {
  const ready =
    !!serviceSid() && !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN;
  return ready ? "whatsapp" : "none";
}

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
}

/** Asks Twilio to generate a code and WhatsApp it to the owner.
 *
 * Throws on failure rather than swallowing it: a silent failure here means the
 * owner sits watching a code-entry screen for a message that is never coming,
 * which is far worse than an error telling them to try again. */
export async function startWhatsAppVerification(mobile: string): Promise<void> {
  const sid = serviceSid();
  if (!sid) throw new Error("TWILIO_VERIFY_SERVICE_SID is not configured");

  const verification = await client()
    .verify.v2.services(sid)
    .verifications.create({ to: mobile, channel: "whatsapp" });

  // Twilio reports a created-but-undeliverable verification as a non-pending
  // status rather than an exception.
  if (verification.status !== "pending") {
    throw new Error(`WhatsApp verification was not queued (status: ${verification.status})`);
  }
}

/** Whether the code the owner typed is the one Twilio sent.
 *
 * Returns false rather than throwing for the ordinary wrong-code case. Twilio
 * 404s a check against a verification that has already been approved, expired,
 * or run out of attempts - all of which are "this code will not get you in",
 * so they are false too. Anything else is a real fault and propagates, because
 * treating an outage as a wrong code would lock every owner out with a
 * misleading message. */
export async function checkWhatsAppVerification(mobile: string, code: string): Promise<boolean> {
  const sid = serviceSid();
  if (!sid) throw new Error("TWILIO_VERIFY_SERVICE_SID is not configured");

  try {
    const check = await client()
      .verify.v2.services(sid)
      .verificationChecks.create({ to: mobile, code });
    return check.status === "approved";
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { status?: number }).status === 404) {
      return false;
    }
    throw err;
  }
}

/** A fresh six-digit code.
 *
 * randomInt, not Math.random: this is the entire strength of the login. It was
 * previously a hard-coded "000000", which was fine while the code was printed
 * on the staging screen for everyone to see, and would have been account
 * takeover of every tenant the moment production existed - the code stayed
 * constant while the on-screen hint that revealed it correctly disappeared.
 *
 * OTP_TEST_CODE still pins it, for automated tests and throwaway environments.
 * It must never be set on a real deployment. */
export function generateCode(): string {
  return process.env.OTP_TEST_CODE || String(randomInt(0, 1_000_000)).padStart(6, "0");
}
