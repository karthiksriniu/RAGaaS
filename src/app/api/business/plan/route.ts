import { NextResponse } from "next/server";
import { getBillingConfig, resolvePlans } from "@/lib/billing";
import { annualSavingPct } from "@/lib/upi";
import { cashfreeConfigured } from "@/lib/cashfree";

export const runtime = "nodejs";

/** What the signup page offers, priced by whatever will actually charge for it.
 *
 * When Cashfree is configured the amounts come from the plans themselves, not
 * from platform_settings: the gateway is the thing that moves the money, so it
 * is the only honest number to put in front of a payer. platform_settings stays
 * the source of truth for the marketing page, and resolvePlans() shouts when
 * the two have drifted apart.
 *
 * Public and deliberately thin - the VPA and the plan ids are not included.
 * Nobody needs to know where the money goes until there is an order saying so. */
export async function GET() {
  const config = await getBillingConfig();

  // The shape the current signup page already reads. Kept so this endpoint can
  // ship before the page that consumes the richer one.
  const fallback = {
    priceInr: config.priceInr,
    annualPriceInr: config.annualPriceInr,
    savingPct: annualSavingPct(config.priceInr, config.annualPriceInr),
    plans: [
      { plan: "monthly" as const, amountPaise: config.amountPaise, source: "config" as const },
      { plan: "annual" as const, amountPaise: config.annualAmountPaise, source: "config" as const },
    ],
  };

  if (!cashfreeConfigured() || (!config.planIdMonthly && !config.planIdAnnual)) {
    return NextResponse.json(fallback);
  }

  try {
    const resolved = await resolvePlans();
    if (resolved.length === 0) return NextResponse.json(fallback);

    const byPlan = new Map(resolved.map((r) => [r.plan, r]));
    const monthlyInr = Math.round((byPlan.get("monthly")?.amountPaise ?? config.amountPaise) / 100);
    const annualInr = Math.round((byPlan.get("annual")?.amountPaise ?? config.annualAmountPaise) / 100);

    return NextResponse.json({
      priceInr: monthlyInr,
      annualPriceInr: annualInr,
      savingPct: annualSavingPct(monthlyInr, annualInr),
      plans: resolved.map((r) => ({
        plan: r.plan,
        amountPaise: r.amountPaise,
        intervalType: r.intervalType,
        source: "cashfree" as const,
      })),
    });
  } catch (err) {
    // A misconfigured plan id throws from resolvePlans, and a gateway having a
    // bad minute throws from the fetch. Neither should take signup's pricing
    // screen down - it falls back to the configured price, which is what it
    // showed before Cashfree existed. Loud, because a persistent failure here
    // means the page and the charge can disagree.
    console.error("[plan] could not resolve plans from Cashfree, showing configured price:", err);
    return NextResponse.json(fallback);
  }
}
