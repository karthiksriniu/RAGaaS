import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  confirmOrder,
  findOrderByReference,
  PaymentOrderClosedError,
} from "@/lib/billing";

export const runtime = "nodejs";

/** Machine confirmation that a UPI credit arrived.
 *
 * CUB publishes nothing about `karthik.sreeni@cub`, so the only automatable
 * source of truth is the credit alert that reaches Karthik's own phone. This
 * endpoint is the seam for whatever reads it - a phone shortcut, a mail rule, a
 * future aggregator webhook. Nothing uses it yet; it exists now so that plumbing
 * needs no code change here when it arrives, and so the admin button is a
 * convenience rather than the only way in.
 *
 * Auth is a single shared secret in UPI_CONFIRM_SECRET. Unset means the
 * endpoint is off entirely rather than open - an unauthenticated route that
 * hands out month-long licences is not something to leave enabled by default.
 *
 * Retry-safe: confirming an already-confirmed order returns it unchanged. */
export async function POST(req: NextRequest) {
  const secret = process.env.UPI_CONFIRM_SECRET;
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const header = req.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hashed before comparing so the compare is over fixed-length buffers and
  // cannot leak the secret's length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  if (!timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  if (!reference) {
    return NextResponse.json(
      { error: "reference is required - the MBC order id from the payment note, or the UTR" },
      { status: 400 }
    );
  }

  const order = await findOrderByReference(reference);
  if (!order) return NextResponse.json({ error: `No payment order for "${reference}"` }, { status: 404 });

  // A credit for the wrong amount must not license a month. Only checked when
  // the caller actually knows the amount - a bare reference is still accepted,
  // since the admin queue is the fallback for anything ambiguous.
  const amountPaise = Number.isFinite(body.amountPaise) ? Number(body.amountPaise) : null;
  if (amountPaise !== null && amountPaise !== order.amountPaise) {
    return NextResponse.json(
      { error: `Amount mismatch: order ${order.id} is for ${order.amountPaise} paise, not ${amountPaise}` },
      { status: 409 }
    );
  }

  try {
    const confirmed = await confirmOrder(order.id, "webhook");
    return NextResponse.json({
      ok: true,
      orderId: confirmed.id,
      status: confirmed.status,
      tenantId: confirmed.tenantId,
      licensedUntil: confirmed.licensedUntil,
    });
  } catch (err) {
    if (err instanceof PaymentOrderClosedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
