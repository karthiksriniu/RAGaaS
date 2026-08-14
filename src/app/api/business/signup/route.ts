import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { pool } from "@/lib/db";
import {
  BUSINESS_SESSION_COOKIE,
  createBusinessSession,
  newAccountId,
  normalizeMobile,
} from "@/lib/businessAuth";
import { provisionTenant, enhanceKbFromWebsite } from "@/lib/provisionTenant";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
// Provisioning creates a tenant, claims a number and generates a starter KB
// with an LLM call - comfortably longer than the default budget.
// Covers the background website read scheduled with after(), not the response
// itself - after() runs within the route's max duration, and signup now
// answers in roughly 25s.
export const maxDuration = 300;

/** Completes signup after the (bypassed) payment step: creates the tenant,
 * claims a pooled number, seeds the agent, and logs the owner in.
 *
 * The mobile must already have been OTP-verified. That is enforced by
 * requiring the number to have no outstanding challenge AND not already own an
 * account - a caller who never verified would still hold a live challenge row. */
export async function POST(req: NextRequest) {
  const { mobile, businessName, description, website } = await req.json().catch(() => ({}));
  const normalized = normalizeMobile(mobile || "");
  const name = typeof businessName === "string" ? businessName.trim() : "";

  if (!normalized) return NextResponse.json({ error: "Valid mobile number required" }, { status: 400 });
  if (name.length < 2) return NextResponse.json({ error: "Business name is required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "Business name is too long" }, { status: 400 });

  const desc = typeof description === "string" ? description.trim().slice(0, 1000) : "";
  const site = typeof website === "string" ? website.trim().slice(0, 300) : "";

  if (!(await checkRateLimit(`signup:${normalized}`, 60 * 60 * 1000, 5))) {
    return NextResponse.json({ error: "Too many signup attempts. Try again later." }, { status: 429 });
  }

  // Proof of verification: verifyOtp deletes the challenge on success, so a
  // surviving row means this number never completed the code step.
  const pending = await pool.query("SELECT 1 FROM otp_challenges WHERE mobile = $1", [normalized]);
  if (pending.rows.length > 0) {
    return NextResponse.json({ error: "Verify your mobile number first" }, { status: 403 });
  }

  const existing = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM business_accounts WHERE mobile = $1",
    [normalized]
  );
  if (existing.rows.length > 0) {
    // Idempotent: a retried or double-submitted signup logs in rather than
    // creating a second tenant and burning a second pooled number.
    const tenantId = existing.rows[0].tenant_id;
    const res = NextResponse.json({ ok: true, alreadyRegistered: true, tenantId });
    res.cookies.set(BUSINESS_SESSION_COOKIE, createBusinessSession(tenantId), {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  const provisioned = await provisionTenant(name, desc, site);

  // Reading the business's website takes 60-80s. after() runs it once the
  // response has been sent, so the business sees "You're live" immediately
  // instead of watching a spinner for minutes.
  //
  // NOT durable: this is still the same invocation, so if the instance dies
  // mid-read the work is lost. That is why the tenant carries a status - a
  // stuck "pending" is visible and retryable, where a silent loss would not be.
  if (provisioned.websiteToRead) {
    const websiteToRead = provisioned.websiteToRead;
    after(async () => {
      await enhanceKbFromWebsite(provisioned.tenantId, name, desc, websiteToRead);
    });
  }

  await pool.query(
    "INSERT INTO business_accounts (id, mobile, tenant_id) VALUES ($1, $2, $3)",
    [newAccountId(), normalized, provisioned.tenantId]
  );

  const res = NextResponse.json({
    ok: true,
    tenantId: provisioned.tenantId,
    phoneNumber: provisioned.phoneNumber,
    starterKbChunks: provisioned.starterKbChunks,
    readingWebsite: !!provisioned.websiteToRead,
  });
  res.cookies.set(BUSINESS_SESSION_COOKIE, createBusinessSession(provisioned.tenantId), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
