import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { businessTenantId, hasVerifiedRecently, normalizeMobile } from "@/lib/businessAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  confirmOrder,
  openOrderForMobile,
  paymentInstructions,
  type PaymentOrder,
} from "@/lib/billing";
import { upiPaymentsEnabled } from "@/lib/upi";

export const runtime = "nodejs";

/** Opens (or re-opens) the ₹999 payment for a signup or a renewal.
 *
 * Two callers, authenticated two different ways, because at signup there is no
 * session yet - the mobile has only been OTP-verified:
 *
 *  - signup:  the mobile must carry a recent verification receipt (the same
 *             proof /api/business/signup relies on) and must not already own
 *             an account.
 *  - renewal: an ordinary business session; the tenant and the mobile both come
 *             from it, never from the request body.
 *
 * On staging the order is created and immediately confirmed rather than
 * skipped, so the whole licence path runs there too - the only difference is
 * that nobody has to pay. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const purpose = body.purpose === "renewal" ? "renewal" : "signup";

  let mobile: string;
  let tenantId: string | null = null;

  if (purpose === "renewal") {
    tenantId = businessTenantId(req);
    if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const acct = await pool.query<{ mobile: string }>(
      "SELECT mobile FROM business_accounts WHERE tenant_id = $1",
      [tenantId]
    );
    if (!acct.rows[0]) return NextResponse.json({ error: "No account for this tenant" }, { status: 404 });
    mobile = acct.rows[0].mobile;
  } else {
    const normalized = normalizeMobile(body.mobile || "");
    if (!normalized) return NextResponse.json({ error: "Valid mobile number required" }, { status: 400 });
    mobile = normalized;

    if (!(await hasVerifiedRecently(mobile))) {
      return NextResponse.json({ error: "Verify your mobile number first" }, { status: 403 });
    }
    const existing = await pool.query("SELECT 1 FROM business_accounts WHERE mobile = $1", [mobile]);
    if (existing.rows.length > 0) {
      // Their signup is already done; a renewal has to come through the
      // session-authenticated path above so it lands on the right tenant.
      return NextResponse.json({ error: "This number already has an account - sign in" }, { status: 409 });
    }
  }

  if (!(await checkRateLimit(`payment-order:${mobile}`, 60 * 60 * 1000, 10))) {
    return NextResponse.json({ error: "Too many payment attempts. Try again later." }, { status: 429 });
  }

  let order: PaymentOrder;
  try {
    order = await openOrderForMobile({ mobile, purpose, tenantId });
  } catch (err) {
    // The only way this throws is a missing VPA, which is a platform
    // misconfiguration rather than anything the payer did wrong.
    console.error("[payment] could not open an order:", err);
    return NextResponse.json({ error: "Payments are not configured yet. Please contact support." }, { status: 503 });
  }

  if (!upiPaymentsEnabled()) {
    const settled = order.status === "confirmed" ? order : await confirmOrder(order.id, "simulated");
    return NextResponse.json({
      mode: "simulated",
      orderId: settled.id,
      status: settled.status,
      amountPaise: settled.amountPaise,
      licensedUntil: settled.licensedUntil,
    });
  }

  return NextResponse.json({ mode: "upi", ...(await paymentInstructions(order)) });
}
