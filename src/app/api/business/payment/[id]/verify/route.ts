import { NextRequest, NextResponse } from "next/server";
import { confirmOrder, getOrder, PaymentOrderClosedError } from "@/lib/billing";
import { getSubscription, subscriptionIsAuthorised } from "@/lib/cashfree";
import { paymentProvider } from "@/lib/upi";

export const runtime = "nodejs";

/** Asks Cashfree what actually happened to this order's subscription.
 *
 * Called when the payer lands back from the hosted checkout. Cashfree's own
 * guidance is not to trust the redirect itself - a customer can close the tab,
 * lose signal, or edit the URL - so nothing here reads the query string for a
 * verdict. The gateway is asked directly, and only an ACTIVE subscription
 * confirms the order.
 *
 * This is the FAST path, not the only one: the webhook remains the reliable
 * one for a payer who never comes back. Both funnel into the same
 * confirmOrder(), which is idempotent, so whichever arrives second is a no-op.
 *
 * Unauthenticated by design, like the status route beside it: it takes an
 * order id, reveals nothing but that order's own status, and cannot grant
 * anything the gateway has not already been asked about. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  // Already settled by the webhook, or by a previous call to this route.
  if (order.status === "confirmed") {
    return NextResponse.json({ ok: true, status: order.status, plan: order.plan });
  }
  if (paymentProvider() !== "cashfree" || !order.cfSubscriptionId) {
    return NextResponse.json({ ok: false, status: order.status, plan: order.plan });
  }

  let authorised: boolean;
  try {
    // Queried by OUR subscription_id - the order id - which is what we sent as
    // subscription_id at creation, not Cashfree's cf_subscription_id.
    const sub = await getSubscription(order.id);
    authorised = subscriptionIsAuthorised(sub);
    if (!authorised) {
      console.log(`[verify] order ${order.id} subscription is ${sub.subscription_status}, not ACTIVE`);
    }
  } catch (err) {
    console.error("[verify] could not read subscription for order", order.id, err);
    return NextResponse.json({ error: "Could not check the payment" }, { status: 502 });
  }

  if (!authorised) {
    return NextResponse.json({ ok: false, status: order.status, plan: order.plan });
  }

  try {
    const confirmed = await confirmOrder(order.id, "cashfree-verify");
    return NextResponse.json({ ok: true, status: confirmed.status, plan: confirmed.plan });
  } catch (err) {
    if (err instanceof PaymentOrderClosedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
