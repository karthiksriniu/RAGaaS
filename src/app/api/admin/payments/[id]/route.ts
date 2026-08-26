import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import {
  confirmOrder,
  listOrders,
  rejectOrder,
  PaymentOrderClosedError,
  PaymentOrderNotFoundError,
} from "@/lib/billing";

export const runtime = "nodejs";

/** Confirm or reject one payment, having looked at the bank app.
 *
 * Confirming turns the payer's 3-day provisional licence into a full month
 * measured from when they paid. Rejecting ends it immediately rather than
 * letting the remaining days run - a wrong call in either direction is cheap to
 * reverse while the window is this short. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { action } = await req.json().catch(() => ({}));

  if (action !== "confirm" && action !== "reject") {
    return NextResponse.json({ error: 'action must be "confirm" or "reject"' }, { status: 400 });
  }

  try {
    const order = action === "confirm" ? await confirmOrder(id, "admin") : await rejectOrder(id);
    return NextResponse.json({ ok: true, order, orders: await listOrders() });
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
