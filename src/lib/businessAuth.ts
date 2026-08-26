import { randomBytes, createHmac, timingSafeEqual, createHash } from "crypto";
import type { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import {
  generateCode,
  configuredChannel,
  startWhatsAppVerification,
  checkWhatsAppVerification,
  startVoiceVerification,
} from "@/lib/otpDelivery";

// Auth for business owners. Identity is a mobile number verified by OTP - there
// is no password anywhere in this flow, so nothing to store, leak or reset.
//
// Reuses the HMAC session shape from adminAuth.ts with one difference that
// matters: an admin token only proves "issued by us", because there is exactly
// one admin. A business token must also say WHICH tenant, so the tenant id is
// inside the signed payload and cannot be swapped by editing the cookie.

export const BUSINESS_SESSION_COOKIE = "mybizcare_business_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const OTP_TTL_MS = 1000 * 60 * 10; // 10 minutes
const MAX_OTP_ATTEMPTS = 5;


/** Whether it is safe to hand the code back to the browser.
 *
 * NOT NODE_ENV: Vercel sets that to "production" on the staging project too,
 * so keying off it hides the code exactly where it is needed. The root domain
 * is what actually distinguishes the environments. Setting OTP_TEST_CODE is an
 * explicit override for any other non-production deployment. */
function mayRevealCode(): boolean {
  if (process.env.OTP_TEST_CODE) return true;
  return (process.env.TENANT_ROOT_DOMAIN || "").startsWith("staging.");
}

function secret(): string {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s) throw new Error("ADMIN_SESSION_SECRET is not configured");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

/** Indian mobile numbers, normalised to E.164 so one person cannot end up with
 * two accounts by typing the same number two ways. */
export function normalizeMobile(raw: string): string | null {
  const digits = (raw || "").replace(/[^\d+]/g, "");
  let n = digits;
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("00")) n = n.slice(2);
  if (n.startsWith("91") && n.length === 12) n = n.slice(2);
  if (n.startsWith("0") && n.length === 11) n = n.slice(1);
  if (!/^[6-9]\d{9}$/.test(n)) return null; // Indian mobiles start 6-9
  return `+91${n}`;
}

function hashCode(mobile: string, code: string): string {
  // Salted by mobile so identical codes for different numbers don't collide,
  // and the stored value is useless on its own.
  return createHash("sha256").update(`${mobile}:${code}:${secret()}`).digest("hex");
}

export interface SentOtp {
  /** Only populated when the environment cannot deliver, so staging can show
   * the code on screen. Never returned to the browser in production. */
  devCode?: string;
}

export class OtpUndeliverableError extends Error {
  constructor() {
    super("Verification codes cannot be sent from this environment yet.");
    this.name = "OtpUndeliverableError";
  }
}

/** Issues an OTP challenge and gets the code to the owner.
 *
 * Two channels, chosen by what the environment can actually do:
 *
 *  - WhatsApp, via Twilio Verify. Twilio generates, sends and later checks the
 *    code, so nothing of ours is stored for it - the local row below exists
 *    only to carry expiry, the attempt cap, and the "was this number verified"
 *    receipt that signup depends on. Its code_hash is deliberately random so a
 *    local comparison can never accidentally succeed for this channel.
 *  - None, for staging, where the code comes back to the browser and is shown
 *    on screen instead of being sent.
 *
 * The combination "cannot deliver" AND "must not reveal" THROWS. That pairing
 * only happens on a production deployment with no sender configured, and the
 * alternative is issuing a code the owner has no way of receiving and no way
 * of knowing was never sent. Failing loudly at signup is a far better outcome
 * than a silent dead end. */
export async function sendOtp(mobile: string): Promise<SentOtp> {
  const channel = configuredChannel();
  const reveal = mayRevealCode();
  if (channel === "none" && !reveal) throw new OtpUndeliverableError();

  // For WhatsApp, Twilio owns the code. For voice and for the on-screen
  // fallback we generate it ourselves, which is what keeps verification on the
  // local path with its expiry and attempt cap.
  const code = channel === "whatsapp" ? null : generateCode();

  // Delivery FIRST. If the carrier rejects the number or the sender is
  // misconfigured, no challenge row is written - so a retry is clean, and the
  // owner is never left holding a live challenge for a code that was not sent.
  if (channel === "whatsapp") await startWhatsAppVerification(mobile);
  if (channel === "vobiz-voice") await startVoiceVerification(mobile, code!);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await pool.query(
    `INSERT INTO otp_challenges (mobile, code_hash, attempts, expires_at)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (mobile) DO UPDATE
       SET code_hash = excluded.code_hash, attempts = 0,
           expires_at = excluded.expires_at, created_at = now()`,
    [mobile, code ? hashCode(mobile, code) : randomBytes(32).toString("hex"), expiresAt]
  );
  // Opportunistic sweep - keeps the table from accumulating abandoned challenges.
  await pool.query("DELETE FROM otp_challenges WHERE expires_at < now() - interval '1 day'");

  // Never log the code itself once it is a real secret being really delivered.
  console.log(`[otp] issued for ${mobile} via ${channel}`);
  // Revealed ONLY when nothing delivered it. On a staging deployment that has
  // a real channel configured, the code was really sent, so showing it on
  // screen as well would be a needless second copy of a live secret.
  return reveal && channel === "none" && code ? { devCode: code } : {};
}

export type OtpResult = "ok" | "invalid" | "expired" | "too_many_attempts" | "not_found";

export async function verifyOtp(mobile: string, code: string): Promise<OtpResult> {
  const res = await pool.query<{ code_hash: string; attempts: number; expired: boolean }>(
    `SELECT code_hash, attempts, (expires_at < now()) AS expired
     FROM otp_challenges WHERE mobile = $1`,
    [mobile]
  );
  const row = res.rows[0];
  if (!row) return "not_found";
  if (row.expired) return "expired";
  if (row.attempts >= MAX_OTP_ATTEMPTS) return "too_many_attempts";

  // Who holds the real code depends on how it was delivered. Read from the
  // environment rather than the row: the channel is a property of the
  // deployment, not of one challenge, and it means no schema change was needed
  // to introduce a second channel.
  let match: boolean;
  if (configuredChannel() === "whatsapp") {
    match = await checkWhatsAppVerification(mobile, code);
  } else {
    const a = Buffer.from(row.code_hash, "hex");
    const b = Buffer.from(hashCode(mobile, code), "hex");
    match = a.length === b.length && timingSafeEqual(a, b);
  }

  if (!match) {
    await pool.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE mobile = $1", [mobile]);
    return "invalid";
  }
  // Single-use: consumed on success so a replayed code cannot log in again.
  await pool.query("DELETE FROM otp_challenges WHERE mobile = $1", [mobile]);
  return "ok";
}

/** "tenantId.expiry.signature" - the tenant is signed, so editing the cookie to
 * another tenant invalidates it rather than granting access. */
export function createBusinessSession(tenantId: string): string {
  const expiry = String(Date.now() + SESSION_TTL_MS);
  const payload = `${tenantId}.${expiry}`;
  return `${payload}.${sign(payload)}`;
}

export function readBusinessSession(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [tenantId, expiry, signature] = parts;
  if (!tenantId || !expiry || !signature) return null;

  const expected = sign(`${tenantId}.${expiry}`);
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  if (Date.now() >= parseInt(expiry, 10)) return null;
  return tenantId;
}

/** The tenant this request is authenticated for, or null. Every business-facing
 * route scopes on this and never on a tenantId from the request body. */
export function businessTenantId(req: NextRequest): string | null {
  return readBusinessSession(req.cookies.get(BUSINESS_SESSION_COOKIE)?.value);
}

export function newAccountId(): string {
  return `acct_${randomBytes(8).toString("hex")}`;
}
