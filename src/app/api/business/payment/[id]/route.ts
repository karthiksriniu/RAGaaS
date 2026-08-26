import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/billing";

export const runtime = "nodejs";

/** What the payment screen polls while it waits.
 *
 * Deliberately thin: status, what it granted, and when the QR goes stale.
 * Nothing here identifies the payer, because the order id is the only
 * credential - it is 45 bits of unguessable reference rather than a session,
 * which is what lets the screen keep polling before any account exists. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  return NextResponse.json({
    orderId: order.id,
    status: order.status,
    purpose: order.purpose,
    licensedUntil: order.licensedUntil,
    qrExpiresAt: order.qrExpiresAt,
  });
}
