import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "crypto";
import { NextRequest } from "next/server";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const ADMIN_SESSION_COOKIE = "agriadvisor_admin_session";

/** Hashes a password as "salt:hash" (both hex) for storage in ADMIN_PASSWORD_HASH. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Builds a "expiry.signature" session token. No user identity encoded - there's
 * exactly one admin credential at this stage, so the token only needs to prove
 * "issued by us, not yet expired". */
export function createSessionToken(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not configured");
  const expiry = String(Date.now() + SESSION_TTL_MS);
  return `${expiry}.${sign(expiry, secret)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || !token) return false;
  const [expiry, signature] = token.split(".");
  if (!expiry || !signature) return false;

  const expected = sign(expiry, secret);
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  return Date.now() < parseInt(expiry, 10);
}

/** Per-route backstop check for /api/admin/* handlers. Proxy is the primary
 * gate, but Next's own docs warn a matcher change or route move can silently
 * drop proxy coverage - route handlers must not rely on it alone. */
export function isAdminSession(req: NextRequest): boolean {
  return verifySessionToken(req.cookies.get(ADMIN_SESSION_COOKIE)?.value);
}
