import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { pool } from "@/lib/db";
import {
  BUSINESS_SESSION_COOKIE,
  consumeVerification,
  createBusinessSession,
  hasVerifiedRecently,
  newAccountId,
  normalizeMobile,
} from "@/lib/businessAuth";
import { provisionTenant, enhanceKbFromWebsite } from "@/lib/provisionTenant";
import { checkRateLimit } from "@/lib/rateLimit";
import { attachTenantToOrder, getOrder, setOrderLicensedUntil } from "@/lib/billing";
import { grantLicense } from "@/lib/tenants";
import { licenseKindFor, upiPaymentsEnabled } from "@/lib/upi";

export const runtime = "nodejs";
// Provisioning creates a tenant, claims a number and generates a starter KB
// with an LLM call - comfortably longer than the default budget.
// Covers the background website read scheduled with after(), not the response
// itself - after() runs within the route's max duration, and signup now
// answers in roughly 25s.
export const maxDuration = 300;

/** Completes signup after the payment step: creates the tenant, claims a
 * pooled number, seeds the agent, licenses it, and logs the owner in.
 *
 * The mobile must already have been OTP-verified. That is enforced by
 * requiring the number to have no outstanding challenge AND not already own an
 * account - a caller who never verified would still hold a live challenge row.
 *
 * It must also have paid. The order carries how much licence that payment is
 * worth: three days for a payer's own word, a full month once the credit has
 * actually been seen. See src/lib/upi.ts. */
export async function POST(req: NextRequest) {
  const { mobile, businessName, description, website, orderId } = await req.json().catch(() => ({}));
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

  // Proof of verification, positively: a receipt from verifyOtp, still inside
  // its window. This used to test that NO challenge row survived - which was
  // equally true of a mobile that had never requested a code, so signup could
  // be driven against someone else's number by skipping the OTP step.
  if (!(await hasVerifiedRecently(normalized))) {
    return NextResponse.json({ error: "Verify your mobile number first" }, { status: 403 });
  }

  // Proof of payment, and how much licence it is worth. Skipped only where
  // there is no real payment to make - a staging deployment, where
  // /api/business/payment/order settles its orders on the spot.
  const order = typeof orderId === "string" && orderId ? await getOrder(orderId) : null;
  const licenseKind = order ? licenseKindFor(order.status) : null;
  if (upiPaymentsEnabled()) {
    if (!order || order.mobile !== normalized || order.purpose !== "signup") {
      return NextResponse.json({ error: "Complete the payment first" }, { status: 402 });
    }
    // A signup order with a tenant has already been spent. Without this, a
    // replayed request could hand a second tenant - and a second phone number -
    // to one payment.
    if (order.tenantId) {
      return NextResponse.json({ error: "That payment has already been used" }, { status: 409 });
    }
    if (!licenseKind) {
      return NextResponse.json({ error: "That payment hasn't gone through yet" }, { status: 402 });
    }
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

  // Buying a number is gated on a CONFIRMED payment, not a claimed one - a
  // claim is the payer's own word, and a number costs real money every month.
  // A pooled number is still handed out either way, since that costs nothing
  // new; confirmOrder() buys one later if the pool was empty.
  const provisioned = await provisionTenant(name, desc, site, licenseKind === "full");

  // Licence and payment BEFORE anything slow or best-effort below. A tenant
  // that exists but is unlicensed answers no calls, so this is the step that
  // must not be skipped by a later failure - and attaching the tenant to the
  // order is what marks that payment spent.
  let licenseExpiresAt: string | null = null;
  if (order) {
    await attachTenantToOrder(order.id, provisioned.tenantId);
    licenseExpiresAt = await grantLicense(
      provisioned.tenantId,
      licenseKind ?? "provisional",
      new Date(order.claimedAt || order.createdAt)
    );
    await setOrderLicensedUntil(order.id, licenseExpiresAt);
  }

  // Reading the business's website takes ~20-25s (a 2-level scrape plus one
  // model call - it was 200s when the model did the fetching). after() runs it
  // once the response has been sent, so the business sees "You're live"
  // immediately rather than waiting on it at all.
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
  // One verification, one account.
  await consumeVerification(normalized);

  const res = NextResponse.json({
    ok: true,
    tenantId: provisioned.tenantId,
    phoneNumber: provisioned.phoneNumber,
    starterKbChunks: provisioned.starterKbChunks,
    readingWebsite: !!provisioned.websiteToRead,
    licenseExpiresAt,
    licenseState: licenseKind === "full" ? "active" : "provisional",
  });
  res.cookies.set(BUSINESS_SESSION_COOKIE, createBusinessSession(provisioned.tenantId), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
