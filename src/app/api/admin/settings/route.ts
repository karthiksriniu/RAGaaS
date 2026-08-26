import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { getBillingConfig, updateBillingConfig } from "@/lib/billing";
import { upiPaymentsEnabled } from "@/lib/upi";

export const runtime = "nodejs";

// A VPA is `identifier@handle` - the local part allows letters, digits and
// .-_ , which covers karthik.sreeni@cub and every bank handle in use.
const VPA = /^[a-zA-Z0-9.\-_]{2,60}@[a-zA-Z][a-zA-Z0-9.\-_]{1,30}$/;

export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    billing: await getBillingConfig(),
    // So the admin page can say plainly whether this environment collects real
    // money or simulates it, rather than leaving someone to infer it.
    upiPaymentsEnabled: upiPaymentsEnabled(),
  });
}

export async function PATCH(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, string> = {};

  if (body.vpa !== undefined) {
    const vpa = String(body.vpa).trim();
    if (!VPA.test(vpa)) {
      return NextResponse.json({ error: "That doesn't look like a UPI ID, e.g. name@bank" }, { status: 400 });
    }
    patch.upi_vpa = vpa;
  }

  if (body.payeeName !== undefined) {
    const name = String(body.payeeName).trim();
    if (name.length < 2 || name.length > 40) {
      return NextResponse.json({ error: "Payee name must be 2-40 characters" }, { status: 400 });
    }
    patch.upi_payee_name = name;
  }

  if (body.priceInr !== undefined) {
    const price = parseInt(String(body.priceInr), 10);
    if (!Number.isFinite(price) || price < 1 || price > 100000) {
      return NextResponse.json({ error: "Price must be between ₹1 and ₹100000" }, { status: 400 });
    }
    patch.plan_price_inr = String(price);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Only affects orders opened from here on: every order snapshots the VPA,
  // payee and amount it was created with, so anyone currently looking at a QR
  // still pays what that QR says.
  return NextResponse.json({ billing: await updateBillingConfig(patch) });
}
