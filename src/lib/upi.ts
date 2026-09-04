import { randomBytes } from "crypto";

// The pure half of billing: prices, the UPI deep link, order identifiers and
// the order state machine's guards. Dependency-free on purpose (like mobile.ts
// and voicePresets.ts) so all of it is unit-testable without a database, and
// so the payment page and the API can share one definition of what is legal.
//
// The DB-backed half - reading config, writing orders, granting licences -
// lives in billing.ts.

/** ₹999/month. */
export const PLAN_PRICE_INR = 999;

/** ₹9999/year - twelve months for the price of ten, near enough.
 *
 * The discount is the point rather than the price: a business on the annual
 * plan makes no monthly decision to keep paying, and a monthly decision is the
 * thing that churns. */
export const PLAN_PRICE_ANNUAL_INR = 9999;

export type Plan = "monthly" | "annual";

/** Narrows whatever arrived in a request body. Plan comes from the browser, and
 * it decides how much is charged and how long a licence runs - so it is checked
 * here rather than trusted anywhere. */
export function isPlan(value: unknown): value is Plan {
  return value === "monthly" || value === "annual";
}

/** Prices default to the compiled constants, but both are overridable because
 * platform_settings is the real source of truth (see getBillingConfig) - the
 * marketing page and the mandate must never be able to disagree. */
export function priceInrForPlan(
  plan: Plan,
  monthlyInr: number = PLAN_PRICE_INR,
  annualInr: number = PLAN_PRICE_ANNUAL_INR
): number {
  return plan === "annual" ? annualInr : monthlyInr;
}

/** The Postgres interval one paid cycle of this plan is worth.
 *
 * Returned as an interval string, not a day count, so grantLicense stays
 * calendar-correct the way it already is for months: 31 Jan + 1 month is
 * 28 Feb, and 29 Feb + 1 year is 28 Feb. Day arithmetic gets both wrong. */
export function licensePeriodFor(plan: Plan): "1 month" | "1 year" {
  return plan === "annual" ? "1 year" : "1 month";
}

/** What the annual plan saves against paying monthly for a year, as a whole
 * percent. For the signup page's "save 17%" - computed, never typed in, so it
 * cannot drift from the two prices it describes. */
export function annualSavingPct(
  monthlyInr: number = PLAN_PRICE_INR,
  annualInr: number = PLAN_PRICE_ANNUAL_INR
): number {
  const twelveMonths = monthlyInr * 12;
  if (twelveMonths <= 0) return 0;
  return Math.round(((twelveMonths - annualInr) / twelveMonths) * 100);
}

/** How long a payer gets on nothing more than their own word that they paid.
 *
 * A bank VPA reports nothing to us, so the credit is confirmed out of band by
 * an admin or the confirm webhook. Rather than hold someone on a spinner until
 * that happens, they are let straight in on a licence this short, which the
 * confirmation then extends to a full month. If confirmation never comes the
 * licence lapses on its own - assertTenantLicensed already gates /api/ask,
 * /api/voice/retrieve and /api/escalate, so the agent simply stops answering.
 * Nothing has to be torn down, and nobody has to remember to do it. */
export const PROVISIONAL_DAYS = 3;

/** How long one QR stays valid. Long enough to find your phone, install the
 * app, and try again after a failed attempt; short enough that a stale
 * reference is not still floating about the next day. */
export const QR_TTL_MINUTES = 45;

export type PaymentProvider = "cashfree" | "upi" | "simulated";

/** Which payment path a new order takes.
 *
 * Three-way, replacing the old upiPaymentsEnabled() boolean, because there are
 * now three real states rather than two: the gateway, the legacy direct-VPA QR
 * kept as a fallback, and staging's simulated bypass that settles an order on
 * the spot so signup stays testable without anyone paying.
 *
 * CASHFREE_PAYMENTS=on is what lets staging exercise the real sandbox instead
 * of the bypass - the same shape of override as UPI_PAYMENTS, and the same
 * reason: an environment must be able to opt into the real flow without being
 * moved to production.
 *
 * upiPaymentsEnabled() is left exactly as it was and still governs the UPI
 * path, so nothing that reads it today changes behaviour. */
export function paymentProvider(): PaymentProvider {
  if (process.env.CASHFREE_PAYMENTS === "on") return "cashfree";
  if (process.env.CASHFREE_PAYMENTS === "off") return upiPaymentsEnabled() ? "upi" : "simulated";
  // Unset: production uses the gateway, staging keeps its bypass.
  return upiPaymentsEnabled() ? "cashfree" : "simulated";
}

export type OrderStatus = "pending" | "claimed" | "confirmed" | "rejected" | "expired";
export type OrderPurpose = "signup" | "renewal";

/** Real UPI payments, or the simulated bypass?
 *
 * Same convention as businessAuth.mayRevealCode and the KB route: NOT NODE_ENV,
 * which Vercel reports as "production" on the staging project too. The root
 * domain is what actually distinguishes the environments.
 *
 * UPI_PAYMENTS=on is an explicit override so the real QR flow can be exercised
 * on staging without moving the whole environment to it. Off by default there,
 * because signup has to stay testable without anyone actually paying ₹999. */
export function upiPaymentsEnabled(): boolean {
  if (process.env.UPI_PAYMENTS === "on") return true;
  if (process.env.UPI_PAYMENTS === "off") return false;
  return !(process.env.TENANT_ROOT_DOMAIN || "").startsWith("staging.");
}

// Every confusable pair removed: O/0, I/1, S/5, B/8, Z/2. This id is matched
// by eye against a payment note in a bank app, so a glyph someone can misread
// is a payment confirmed against the wrong business. Caught in testing, by
// misreading MBC5RSFPR8KK as MBC5R5FPR8KK off a screen. 26 characters still
// gives 26^9 ~ 5.4e12 combinations, which is far more than this needs.
const ID_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";

/** "MBC" + 9 characters. Doubles as the UPI transaction reference (tr), so it
 * must stay alphanumeric and under UPI's 35-character limit - it is the only
 * handle tying a credit in someone's bank app back to the business that owes
 * it. */
export function newOrderId(): string {
  const bytes = randomBytes(9);
  let out = "MBC";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export interface UpiUriInput {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  orderId: string;
}

/** The `upi://pay` deep link every Indian payment app understands - scanned as
 * a QR on desktop, opened directly on mobile.
 *
 * The amount is fixed in the link, so the payer cannot mistype it and we are
 * never left reconciling ₹99 against a ₹999 order. Composed server-side for
 * the same reason: the amount and the payee are not the browser's to decide. */
export function buildUpiUri({ vpa, payeeName, amountPaise, orderId }: UpiUriInput): string {
  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: (amountPaise / 100).toFixed(2),
    cu: "INR",
    tn: `MyBizCare ${orderId}`,
    tr: orderId,
  });
  // Two fixes to what URLSearchParams produces, both about what UPI apps
  // actually parse rather than what the URL spec permits:
  //  - "+" for a space is shown literally in the payment note by some apps.
  //  - "%40" for the "@" in the VPA is legal but not what any UPI QR in the
  //    wild contains, and the stricter scanners do not decode it.
  return `upi://pay?${params.toString().replace(/\+/g, "%20").replace(/%40/g, "@")}`;
}

/** A UPI reference number as printed in a payment app: 12 digits. Optional
 * everywhere - it only speeds up matching a claim to a credit alert - so this
 * returns null rather than throwing for anything that isn't one. */
export function normalizeUtr(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

export interface OrderState {
  status: OrderStatus;
  qrExpiresAt: string | Date;
}

/** Still worth showing a QR for: nothing has been claimed and the window is
 * open. A claimed order is deliberately NOT open - the payer has moved on, and
 * re-opening it would invite a second payment against one reference. */
export function isOpenForPayment(order: OrderState, now: Date = new Date()): boolean {
  return order.status === "pending" && new Date(order.qrExpiresAt) > now;
}

/** A claim is the payer saying "I've paid". Only a live pending order accepts
 * one; claiming twice is a no-op rather than a second provisional licence. */
export function canClaim(order: OrderState, now: Date = new Date()): boolean {
  return isOpenForPayment(order, now);
}

/** Confirmation can arrive for an order that was never claimed - someone pays
 * and closes the tab before tapping anything - so pending counts too. An
 * already-confirmed order is not re-confirmable, which is what makes the
 * webhook safe to retry. */
export function canConfirm(order: OrderState): boolean {
  return order.status === "pending" || order.status === "claimed";
}

/** What a licence granted by an order in this state should be worth. */
export function licenseKindFor(status: OrderStatus): "provisional" | "full" | null {
  if (status === "claimed") return "provisional";
  if (status === "confirmed") return "full";
  return null;
}
