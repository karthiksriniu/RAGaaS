import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { listOrders } from "@/lib/billing";

export const runtime = "nodejs";

/** The payments queue. Orders awaiting a human decision sort to the top -
 * every one of them is a business already using the product on a provisional
 * licence that runs out in three days. */
export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ orders: await listOrders() });
}
