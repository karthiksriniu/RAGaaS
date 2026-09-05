import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { businessTenantId, hasVerifiedRecently, normalizeMobile } from "@/lib/businessAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  attachCashfreeToOrder,
  confirmOrder,
  getBillingConfig,
  openOrderForMobile,
  paymentInstructions,
  type PaymentOrder,
} from "@/lib/billing";
import { isPlan, paymentProvider, type Plan } from "@/lib/upi";
import {
  CashfreeApiError,
  cashfreeEnv,
  createSubscription,
  getSubscription,
  onePeriodAfter,
  subscriptionAuthPay,
  subscriptionIsAuthorised,
  type CashfreeSubscription,
} from "@/lib/cashfree";

/** Cashfree's own words, but only away from production.
 *
 * A gateway error names the exact field it disliked, which is the difference
 * between a five-second fix and an afternoon - and on staging there is nobody
 * to protect it from. In production it stays out of the response: it can carry
 * request detail, and a payer can do nothing with it anyway. */
function gatewayDetail(err: unknown): Record<string, unknown> {
  if (cashfreeEnv() === "production") return {};
  if (err instanceof CashfreeApiError) {
    return { detail: { status: err.status, code: err.code, message: err.message } };
  }
  return { detail: { message: err instanceof Error ? err.message : String(err) } };
}

/** Good enough to catch a typo, deliberately not a full RFC 5322 parse.
 * Cashfree does its own validation and will reject anything it dislikes; the
 * point here is to fail before we create an order, not to be authoritative. */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

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
  const plan: Plan = isPlan(body.plan) ? body.plan : "monthly";
  const provider = paymentProvider();
  const email = normalizeEmail(body.email);

  // Cashfree will not create a subscription without one, so this is refused
  // here rather than surfacing as a gateway error the payer cannot act on.
  if (provider === "cashfree" && !email) {
    return NextResponse.json(
      { error: "A valid email address is required for your receipt" },
      { status: 400 }
    );
  }

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
    order = await openOrderForMobile({
      mobile,
      purpose,
      tenantId,
      plan,
      customerEmail: email,
      provider,
    });
  } catch (err) {
    // The only way this throws is a missing VPA on the UPI path, which is a
    // platform misconfiguration rather than anything the payer did wrong.
    console.error("[payment] could not open an order:", err);
    return NextResponse.json({ error: "Payments are not configured yet. Please contact support." }, { status: 503 });
  }

  if (provider === "simulated") {
    const settled = order.status === "confirmed" ? order : await confirmOrder(order.id, "simulated");
    return NextResponse.json({
      mode: "simulated",
      orderId: settled.id,
      status: settled.status,
      plan: settled.plan,
      amountPaise: settled.amountPaise,
      licensedUntil: settled.licensedUntil,
    });
  }

  if (provider === "cashfree") {
    const config = await getBillingConfig();
    const planId = plan === "annual" ? config.planIdAnnual : config.planIdMonthly;
    if (!planId) {
      console.error(`[payment] no Cashfree plan id configured for the ${plan} plan`);
      return NextResponse.json({ error: "Payments are not configured yet. Please contact support." }, { status: 503 });
    }

    const root = process.env.TENANT_ROOT_DOMAIN || "";
    const returnUrl = `https://${root}/signup?order=${encodeURIComponent(order.id)}`;

    try {
      // An order is reused for as long as it is live, so a second attempt after
      // a failure lands here with a subscription ALREADY created at Cashfree -
      // recreating it under the same subscription_id is refused with
      // `subscription_already_exists`, which then masks whatever actually went
      // wrong the first time. So creation happens only once per order.
      let sessionId = order.cfPaymentSessionId;

      if (!sessionId) {
        let subscription: CashfreeSubscription;
        try {
          subscription = await createSubscription({
            subscriptionId: order.id,
            planId,
            customerName: body.businessName?.toString().trim().slice(0, 100) || "MyBizCare customer",
            customerEmail: email!,
            customerPhone: order.mobile,
            // The first cycle, collected at authorisation and not refunded.
            // Taken from the ORDER, which was priced from the plan, so the
            // amount authorised is the amount displayed.
            authorizationAmountInr: Math.round(order.amountPaise / 100),
            returnUrl,
            // One full period out. The authorisation above already collects
            // cycle one; scheduling the first periodic charge for "now" would
            // bill the customer twice in their first week.
            firstChargeAt: onePeriodAfter(new Date(), plan),
          });
        } catch (err) {
          // Created by an earlier attempt whose session we never stored. Adopt
          // it rather than failing: the customer has one subscription either
          // way, and a new id would orphan the old one at the gateway.
          if (err instanceof CashfreeApiError && err.code === "subscription_already_exists") {
            console.warn(`[payment] adopting existing Cashfree subscription for order ${order.id}`);
            subscription = await getSubscription(order.id);
          } else {
            throw err;
          }
        }

        // The money is already in - an authorisation that succeeded while we
        // were failing to hear about it. Confirm rather than charging again.
        if (subscriptionIsAuthorised(subscription)) {
          console.log(`[payment] order ${order.id} was already authorised at Cashfree`);
          const confirmed = await confirmOrder(order.id, "cashfree-adopted");
          return NextResponse.json({
            mode: "paid",
            orderId: confirmed.id,
            plan: confirmed.plan,
            status: confirmed.status,
          });
        }

        sessionId = subscription.subscription_session_id ?? null;
        await attachCashfreeToOrder({
          id: order.id,
          cfSubscriptionId: subscription.cf_subscription_id ?? null,
          cfPaymentSessionId: sessionId,
        });
      }

      if (!sessionId) {
        // Adopted a subscription whose session Cashfree will not reissue. The
        // order expires with its QR window and the next attempt gets a fresh
        // id, so this heals itself rather than needing intervention.
        console.error(`[payment] no session id available for order ${order.id}`);
        return NextResponse.json(
          { error: "This payment has expired. Please start again in a few minutes." },
          { status: 409 }
        );
      }

      const auth = await subscriptionAuthPay({
        subscriptionId: order.id,
        // Unique per attempt. A retried authorisation is a NEW payment attempt,
        // and reusing one id would collide at the gateway exactly as the
        // subscription id just did.
        paymentId: `${order.id}A${Date.now().toString(36).toUpperCase()}`,
        subscriptionSessionId: sessionId,
      });

      const redirectUrl = typeof auth.data?.url === "string" ? auth.data.url : null;
      if (!redirectUrl) {
        console.error("[payment] Cashfree AUTH returned no URL", {
          channel: auth.channel,
          action: auth.action,
          data: auth.data,
        });
        return NextResponse.json(
          {
            error: "Could not start the payment. Please try again.",
            ...(cashfreeEnv() === "production"
              ? {}
              : { detail: { stage: "auth", channel: auth.channel, action: auth.action, data: auth.data } }),
          },
          { status: 502 }
        );
      }

      return NextResponse.json({
        mode: "cashfree",
        orderId: order.id,
        plan: order.plan,
        amountPaise: order.amountPaise,
        redirectUrl,
      });
    } catch (err) {
      // Loud: a payer who cannot pay is the one failure that costs a customer.
      console.error("[payment] Cashfree subscription failed for order", order.id, err);
      return NextResponse.json(
        { error: "Could not start the payment. Please try again.", ...gatewayDetail(err) },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({ mode: "upi", ...(await paymentInstructions(order)) });
}
