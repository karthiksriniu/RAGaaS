import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// Carries a verification code from the moment we place the call to the moment
// Vobiz asks us what to say.
//
// The code CANNOT simply be a query parameter. Vobiz fetches answer_url from
// its own infrastructure, so the full URL lands in their request logs, in any
// proxy between us, and in our own access logs - a live verification code
// sitting in plain text in several systems we do not control.
//
// So the code is encrypted into an opaque token with AES-256-GCM. GCM is
// authenticated, so a tampered token fails to decrypt rather than decrypting
// to something attacker-chosen, and no separate signature is needed.
//
// Deliberately stateless: the alternative is storing the plaintext code
// server-side for the answer_url to look up, and a plaintext OTP at rest is
// worse than one that exists only inside a token that expires in minutes.

/** Long enough for the callee to answer and for a "press 1 to repeat", short
 * enough that a leaked token is worthless by the time anyone finds it. */
const TOKEN_TTL_MS = 1000 * 60 * 5;

function key(): Buffer {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not configured");
  // A 32-byte key from the shared secret. Domain-separated so this key can
  // never be the same bytes as anything else derived from that secret.
  return createHash("sha256").update(`otp-voice:${secret}`).digest();
}

export interface OtpVoicePayload {
  code: string;
  mobile: string;
}

export function encodeOtpVoiceToken(payload: OtpVoicePayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Null for anything that is not a currently-valid token - tampered, expired,
 * truncated, or encrypted under a different secret. The caller turns that into
 * a spoken apology rather than an error, because the person on the phone
 * cannot act on a stack trace. */
export function decodeOtpVoiceToken(token: string): OtpVoicePayload | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");

    const parsed = JSON.parse(plaintext) as OtpVoicePayload & { exp: number };
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) return null;
    if (!parsed.code || !parsed.mobile) return null;
    return { code: parsed.code, mobile: parsed.mobile };
  } catch {
    return null;
  }
}

/** "610389" -> "6. 1. 0. 3. 8. 9." - a full stop between digits is what makes
 * the speech engine pause. Read as a whole number it comes out as "six hundred
 * and ten thousand, three hundred and eighty-nine", which nobody can write down. */
export function spokenDigits(code: string): string {
  return code.split("").join(". ") + ".";
}
