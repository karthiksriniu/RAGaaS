import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/** Where Cashfree sends the customer back to after the hosted checkout.
 *
 * This exists as an API route rather than pointing return_url straight at
 * /signup because Cashfree's documentation does not commit to the method: it
 * says the customer is "redirected to the return url", and elsewhere that the
 * merchant receives the result "via a form POST". A page route answers GET
 * only, so a POST would land the payer on a 405 having just paid. Accepting
 * both and bouncing to the page is the one shape that cannot break.
 *
 * Nothing here is trusted as evidence. Whatever Cashfree posts is discarded
 * except the order id we put in the URL ourselves; /api/business/payment/[id]/verify
 * then asks Cashfree what actually happened. */
function bounce(req: NextRequest): NextResponse {
  const order = req.nextUrl.searchParams.get("order") || "";
  const target = new URL("/signup", req.nextUrl.origin);
  if (order) target.searchParams.set("order", order);
  // 303: turns a POST into the GET the signup page expects.
  return NextResponse.redirect(target, 303);
}

export async function GET(req: NextRequest) {
  return bounce(req);
}

export async function POST(req: NextRequest) {
  return bounce(req);
}
