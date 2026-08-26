import { NextRequest, NextResponse } from "next/server";
import {
  claimOrder,
  PaymentOrderClosedError,
  PaymentOrderNotFoundError,
} from "@/lib/billing";
import { checkRateLimit } from "@/lib/rateLimit";
import { normalizeUtr } from "@/lib/upi";

export const runtime = "nodejs";

/** The payer saying "I've paid".
 *
 * This grants the 3-day provisional licence, so it is the moment someone gets
 * in on nothing but their own word. That is the accepted trade: a bank VPA
 * tells us nothing, and holding a paying business on a spinner until a human
 * checks a phone is worse than letting an occasional unpaid claim run for three
 * days and lapse.
 *
 * The UTR is optional and is only ever a matching aid for whoever confirms -
 * nothing is gated on it, so a wrong one costs nobody their access. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!(await checkRateLimit(`payment-claim:${id}`, 60 * 60 * 1000, 10))) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  try {
    const order = await claimOrder(id, normalizeUtr(body.utr));
    return NextResponse.json({
      orderId: order.id,
      status: order.status,
      licensedUntil: order.licensedUntil,
    });
  } catch (err) {
    if (err instanceof PaymentOrderNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PaymentOrderClosedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
