import { NextResponse } from "next/server";
import { getBillingConfig } from "@/lib/billing";

export const runtime = "nodejs";

/** The advertised price, so the signup page shows what the QR will actually
 * ask for. Public and deliberately thin - the price is on the marketing page
 * anyway, and the VPA is not included: nobody needs to know where the money
 * goes until there is an order telling them. */
export async function GET() {
  const { priceInr } = await getBillingConfig();
  return NextResponse.json({ priceInr });
}
