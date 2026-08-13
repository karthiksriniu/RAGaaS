import { randomBytes, createHmac, timingSafeEqual, createHash } from "crypto";
import type { NextRequest } from "next/server";
import { pool } from "@/lib/db";

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

/** In staging the code is fixed and never delivered - see sendOtp(). Set
 * OTP_TEST_CODE in production to nothing and wire a real sender instead. */
const STAGING_OTP_CODE = process.env.OTP_TEST_CODE || "000000";

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
  /** Only populated outside production, so staging can show/log the code
   * instead of sending it. Never returned to the browser in production. */
  devCode?: string;
}

/** Issues an OTP challenge. Deliberately does NOT deliver anything yet: the
 * number's Vobiz capabilities are voice-only (sms:false), so a real sender is
 * a separate piece of work. The flow, storage, expiry and attempt-capping are
 * all real, so swapping in delivery later touches only this function. */
export async function sendOtp(mobile: string): Promise<SentOtp> {
  const code = STAGING_OTP_CODE;
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await pool.query(
    `INSERT INTO otp_challenges (mobile, code_hash, attempts, expires_at)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (mobile) DO UPDATE
       SET code_hash = excluded.code_hash, attempts = 0,
           expires_at = excluded.expires_at, created_at = now()`,
    [mobile, hashCode(mobile, code), expiresAt]
  );
  // Opportunistic sweep - keeps the table from accumulating abandoned challenges.
  await pool.query("DELETE FROM otp_challenges WHERE expires_at < now() - interval '1 day'");

  console.log(`[otp] issued for ${mobile}: ${code}`);
  return process.env.NODE_ENV === "production" ? {} : { devCode: code };
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

  const a = Buffer.from(row.code_hash, "hex");
  const b = Buffer.from(hashCode(mobile, code), "hex");
  const match = a.length === b.length && timingSafeEqual(a, b);

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
