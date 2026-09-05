import { NextResponse } from "next/server";
import { getBillingConfig } from "@/lib/billing";
import {
  cashfreeEnv,
  cashfreeFetch,
  onePeriodAfter,
  CashfreeApiError,
} from "@/lib/cashfree";

export const runtime = "nodejs";

/** Throwaway diagnostic: which AUTH payload does this account actually accept?
 *
 * `payment_mode_invalid_for_action` is not in Cashfree's published error table,
 * and their own AUTH example uses `channel: "link"` - so the failure is either a
 * field we are not sending (their example carries a `upi_id` we omit), a
 * spelling they want elsewhere, or UPI Autopay simply not being enabled on this
 * merchant account. Guessing costs a deploy and a retry each time; this asks all
 * the questions in one request.
 *
 * Admin-gated by proxy.ts, and refuses to run against production - it creates
 * real subscription objects, which is fine in a sandbox and not fine live.
 *
 * DELETE THIS once the working shape is known. It exists to answer one question.
 */
export async function GET() {
  if (cashfreeEnv() === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const config = await getBillingConfig();
  const planId = config.planIdMonthly;
  if (!planId) return NextResponse.json({ error: "No monthly plan id configured" }, { status: 503 });

  const stamp = Date.now().toString(36).toUpperCase();
  const results: unknown[] = [];

  // Two spellings of the authorisation's allowed methods. Cashfree's error text
  // elsewhere names UPI in capitals, so it is worth knowing whether this field
  // is what the "invalid for action" complaint is really about.
  const methodSpellings: string[][] = [["upi"], ["UPI"]];

  // Their documented example carries a upi_id even on the "link" channel, which
  // we have never sent.
  const authVariants: { label: string; upi: Record<string, string> }[] = [
    { label: "link (no upi_id)", upi: { channel: "link" } },
    { label: "link + upi_id", upi: { channel: "link", upi_id: "testsuccess@gocash" } },
    { label: "collect + upi_id", upi: { channel: "collect", upi_id: "testsuccess@gocash" } },
    { label: "qrcode", upi: { channel: "qrcode" } },
  ];

  for (const methods of methodSpellings) {
    const subId = `PROBE${stamp}${methods[0]}`;
    let sessionId: string | null = null;

    try {
      const sub = await cashfreeFetch<{ subscription_session_id?: string; subscription_status?: string }>(
        "/subscriptions",
        {
          method: "POST",
          body: {
            subscription_id: subId,
            customer_details: {
              customer_name: "Probe",
              customer_email: "probe@mybizcare.com",
              customer_phone: "9999999999",
            },
            plan_details: { plan_id: planId },
            authorization_details: {
              authorization_amount: 1,
              authorization_amount_refund: false,
              payment_methods: methods,
            },
            subscription_meta: { return_url: "https://staging.mybizcare.com/signup" },
            subscription_first_charge_time: onePeriodAfter(new Date(), "monthly").toISOString(),
          },
        }
      );
      sessionId = sub.subscription_session_id ?? null;
      results.push({ step: "create", methods, ok: true, status: sub.subscription_status, hasSession: Boolean(sessionId) });
    } catch (err) {
      const e = err as CashfreeApiError;
      results.push({ step: "create", methods, ok: false, status: e.status, code: e.code, message: e.message });
      continue;
    }

    if (!sessionId) continue;

    for (const variant of authVariants) {
      try {
        const auth = await cashfreeFetch<{ channel?: string; action?: string; data?: { url?: string } }>(
          "/subscriptions/pay",
          {
            method: "POST",
            body: {
              subscription_id: subId,
              payment_id: `${subId}-${variant.label.replace(/\W+/g, "")}`,
              payment_type: "AUTH",
              subscription_session_id: sessionId,
              payment_method: { upi: variant.upi },
            },
          }
        );
        results.push({
          step: "auth", methods, variant: variant.label, ok: true,
          channel: auth.channel, action: auth.action, url: auth.data?.url ?? null,
        });
      } catch (err) {
        const e = err as CashfreeApiError;
        results.push({
          step: "auth", methods, variant: variant.label, ok: false,
          status: e.status, code: e.code, message: e.message,
        });
      }
    }
  }

  return NextResponse.json({ env: cashfreeEnv(), planId, results }, { status: 200 });
}
