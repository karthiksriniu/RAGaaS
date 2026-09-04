import QRCode from "qrcode";
import { pool } from "@/lib/db";
import { grantLicense, expireLicenseNow } from "@/lib/tenants";
import {
  PLAN_PRICE_INR,
  PLAN_PRICE_ANNUAL_INR,
  QR_TTL_MINUTES,
  buildUpiUri,
  canClaim,
  canConfirm,
  newOrderId,
  type OrderPurpose,
  type OrderStatus,
  type Plan,
} from "@/lib/upi";
import { getPlan, planKind, planToPaise, type PlanIntervalType } from "@/lib/cashfree";

// The DB-backed half of billing: platform configuration, the payment order
// lifecycle, and the licence each stage of it grants. The pure half - prices,
// the UPI deep link, the state machine's guards - is in upi.ts.

export interface BillingConfig {
  vpa: string;
  payeeName: string;
  priceInr: number;
  amountPaise: number;
  annualPriceInr: number;
  annualAmountPaise: number;
  /** Cashfree plan ids. Per-environment by construction: platform_settings
   * lives in the schema, so staging's sandbox ids and production's live ids
   * never meet. Null until configured. */
  planIdMonthly: string | null;
  planIdAnnual: string | null;
}

/** Where the money goes and how much of it.
 *
 * Three layers, most specific first: the admin-editable platform_settings row,
 * then an environment variable, then the compiled default. The settings row is
 * the one the product actually uses - the env fallback exists so a brand-new
 * environment works before anyone has opened the admin page, and so the VPA can
 * be corrected without database access if it ever comes to that. */
export async function getBillingConfig(): Promise<BillingConfig> {
  const rows = await pool.query<{ key: string; value: string }>(
    "SELECT key, value FROM platform_settings WHERE key = ANY($1)",
    [[
      "upi_vpa",
      "upi_payee_name",
      "plan_price_inr",
      "plan_price_annual_inr",
      "cashfree_plan_id_monthly",
      "cashfree_plan_id_annual",
    ]]
  );
  const settings = new Map(rows.rows.map((r) => [r.key, r.value]));

  const priceInr = positiveIntOr(
    settings.get("plan_price_inr") || process.env.PLAN_PRICE_INR,
    PLAN_PRICE_INR
  );
  const annualPriceInr = positiveIntOr(
    settings.get("plan_price_annual_inr") || process.env.PLAN_PRICE_ANNUAL_INR,
    PLAN_PRICE_ANNUAL_INR
  );

  return {
    vpa: settings.get("upi_vpa") || process.env.UPI_VPA || "",
    payeeName: settings.get("upi_payee_name") || process.env.UPI_PAYEE_NAME || "MyBizCare",
    priceInr,
    amountPaise: priceInr * 100,
    annualPriceInr,
    annualAmountPaise: annualPriceInr * 100,
    planIdMonthly:
      settings.get("cashfree_plan_id_monthly") || process.env.CASHFREE_PLAN_ID_MONTHLY || null,
    planIdAnnual:
      settings.get("cashfree_plan_id_annual") || process.env.CASHFREE_PLAN_ID_ANNUAL || null,
  };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function updateBillingConfig(patch: Partial<Record<
  | "upi_vpa"
  | "upi_payee_name"
  | "plan_price_inr"
  | "plan_price_annual_inr"
  | "cashfree_plan_id_monthly"
  | "cashfree_plan_id_annual",
  string
>>): Promise<BillingConfig> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, value]
    );
  }
  return getBillingConfig();
}

export interface PaymentOrder {
  id: string;
  mobile: string;
  plan: Plan;
  provider: string;
  customerEmail: string | null;
  cfSubscriptionId: string | null;
  cfPaymentSessionId: string | null;
  tenantId: string | null;
  purpose: OrderPurpose;
  amountPaise: number;
  vpa: string;
  payeeName: string;
  status: OrderStatus;
  utr: string | null;
  claimedAt: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  licensedUntil: string | null;
  qrExpiresAt: string;
  createdAt: string;
}

interface OrderRow {
  id: string;
  mobile: string;
  plan: Plan;
  provider: string;
  customer_email: string | null;
  cf_subscription_id: string | null;
  cf_payment_session_id: string | null;
  tenant_id: string | null;
  purpose: OrderPurpose;
  amount_paise: number;
  vpa: string;
  payee_name: string;
  status: OrderStatus;
  utr: string | null;
  claimed_at: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  licensed_until: string | null;
  qr_expires_at: string;
  created_at: string;
}

function mapOrder(row: OrderRow): PaymentOrder {
  return {
    id: row.id,
    mobile: row.mobile,
    plan: row.plan,
    provider: row.provider,
    customerEmail: row.customer_email,
    cfSubscriptionId: row.cf_subscription_id,
    cfPaymentSessionId: row.cf_payment_session_id,
    tenantId: row.tenant_id,
    purpose: row.purpose,
    amountPaise: row.amount_paise,
    vpa: row.vpa,
    payeeName: row.payee_name,
    status: row.status,
    utr: row.utr,
    claimedAt: row.claimed_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    licensedUntil: row.licensed_until,
    qrExpiresAt: row.qr_expires_at,
    createdAt: row.created_at,
  };
}

/** Retires pending orders whose QR window has closed. Opportunistic, like
 * checkRateLimit's cleanup - there is no cron here, and a stale 'pending' row
 * would otherwise be reused forever by openOrderForMobile below. */
async function expireStaleOrders(): Promise<void> {
  await pool.query(
    "UPDATE payment_orders SET status = 'expired' WHERE status = 'pending' AND qr_expires_at < now()"
  );
}

export async function getOrder(id: string): Promise<PaymentOrder | null> {
  const res = await pool.query<OrderRow>("SELECT * FROM payment_orders WHERE id = $1", [id]);
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

/** The most recent order for a mobile that still means something: one that is
 * awaiting payment, or one that has been paid but whose tenant was never
 * provisioned (the tab was closed mid-signup).
 *
 * This is what makes a returning signup resume instead of paying twice. */
export async function liveOrderForMobile(
  mobile: string,
  purpose: OrderPurpose
): Promise<PaymentOrder | null> {
  await expireStaleOrders();
  const res = await pool.query<OrderRow>(
    `SELECT * FROM payment_orders
      WHERE mobile = $1 AND purpose = $2
        AND status IN ('pending', 'claimed', 'confirmed')
        AND (purpose <> 'signup' OR tenant_id IS NULL)
      ORDER BY created_at DESC
      LIMIT 1`,
    [mobile, purpose]
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

/** The most recent order against a tenant, whatever became of it. Used by the
 * dashboard to say "we're still confirming your payment" while a provisional
 * licence is running, rather than letting the business discover on day three
 * that it was never confirmed. */
export async function latestOrderForTenant(tenantId: string): Promise<PaymentOrder | null> {
  const res = await pool.query<OrderRow>(
    "SELECT * FROM payment_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1",
    [tenantId]
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

/** An order to pay against - reusing the live one if there is one.
 *
 * Reuse is the whole point: one mobile, one open reference. Issuing a fresh id
 * on every visit to the plan screen would leave several live references for the
 * same business, and a credit alert quoting one of them could not be matched to
 * the order the payer was actually looking at. */
export async function openOrderForMobile(input: {
  mobile: string;
  purpose: OrderPurpose;
  tenantId?: string | null;
  plan?: Plan;
  customerEmail?: string | null;
  provider?: string;
}): Promise<PaymentOrder> {
  const existing = await liveOrderForMobile(input.mobile, input.purpose);
  // A live order is reused, but the payer may have come back and chosen the
  // other plan - so the plan (and its price) is corrected rather than silently
  // keeping the first choice. The id is what must stay stable, not the amount.
  if (existing) {
    const plan = input.plan ?? existing.plan;
    const email = input.customerEmail ?? existing.customerEmail;
    if (plan === existing.plan && email === existing.customerEmail) return existing;
    const config = await getBillingConfig();
    const res = await pool.query<OrderRow>(
      `UPDATE payment_orders SET plan = $2, amount_paise = $3, customer_email = $4
        WHERE id = $1 RETURNING *`,
      [existing.id, plan, plan === "annual" ? config.annualAmountPaise : config.amountPaise, email]
    );
    return mapOrder(res.rows[0]);
  }

  const config = await getBillingConfig();
  const plan: Plan = input.plan ?? "monthly";
  const provider = input.provider ?? "upi";
  // The VPA only matters to the UPI path; a Cashfree order never shows one, and
  // requiring it would block the gateway on a setting it does not use.
  if (provider === "upi" && !config.vpa) {
    throw new Error("No UPI VPA is configured - set it in /admin");
  }

  const res = await pool.query<OrderRow>(
    `INSERT INTO payment_orders
       (id, mobile, tenant_id, purpose, amount_paise, vpa, payee_name, status, qr_expires_at,
        plan, provider, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now() + $8::interval, $9, $10, $11)
     RETURNING *`,
    [
      newOrderId(),
      input.mobile,
      input.tenantId ?? null,
      input.purpose,
      plan === "annual" ? config.annualAmountPaise : config.amountPaise,
      config.vpa,
      config.payeeName,
      `${QR_TTL_MINUTES} minutes`,
      plan,
      provider,
      input.customerEmail ?? null,
    ]
  );
  return mapOrder(res.rows[0]);
}

/** Records what Cashfree gave back, so a webhook naming a subscription can be
 * traced to the order that created it. */
export async function attachCashfreeToOrder(input: {
  id: string;
  cfSubscriptionId: string | null;
  cfPaymentSessionId: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE payment_orders
        SET cf_subscription_id = $2, cf_payment_session_id = $3, provider = 'cashfree'
      WHERE id = $1`,
    [input.id, input.cfSubscriptionId, input.cfPaymentSessionId]
  );
}

/** The order a Cashfree webhook is about. */
export async function findOrderByCfSubscription(cfSubscriptionId: string): Promise<PaymentOrder | null> {
  const res = await pool.query<OrderRow>(
    "SELECT * FROM payment_orders WHERE cf_subscription_id = $1 ORDER BY created_at DESC LIMIT 1",
    [cfSubscriptionId]
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

/** The payer's own word that they have paid.
 *
 * Grants the provisional licence immediately when the tenant already exists (a
 * renewal). For a signup the tenant does not exist yet, so the licence is
 * granted by the signup route once provisioning creates it - it reads this same
 * status to decide whether that licence is three days or a month.
 *
 * Idempotent: a second claim on an already-claimed order returns it unchanged
 * rather than granting a second window. */
export async function claimOrder(id: string, utr: string | null): Promise<PaymentOrder> {
  const order = await getOrder(id);
  if (!order) throw new PaymentOrderNotFoundError(id);
  if (order.status === "claimed" || order.status === "confirmed") return order;
  if (!canClaim(order)) throw new PaymentOrderClosedError(id, order.status);

  const res = await pool.query<OrderRow>(
    `UPDATE payment_orders
        SET status = 'claimed', claimed_at = now(), utr = coalesce($2, utr)
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, utr]
  );
  // Lost a race with a concurrent claim or confirmation - whatever won is
  // authoritative, and both outcomes are ones the payer wanted.
  if (res.rows.length === 0) return (await getOrder(id))!;

  const claimed = mapOrder(res.rows[0]);

  // Exactly here, and nowhere else in this function: the two early returns
  // above are a re-claim and a lost race, neither of which is a NEW thing for
  // an admin to look at. Lazily imported so web-push is not pulled into every
  // route that touches billing.ts, the same reason giveNumberIfOwed does it.
  // Never throws and is time-bounded - see pushNotify.ts.
  try {
    const { notifyPaymentAwaitingConfirmation } = await import("@/lib/pushNotify");
    await notifyPaymentAwaitingConfirmation(claimed);
  } catch (err) {
    console.error("[push] could not notify for claimed payment", claimed.id, err);
  }

  if (claimed.tenantId) {
    const until = await grantLicense(claimed.tenantId, "provisional", new Date(claimed.claimedAt!), claimed.plan);
    return recordLicensedUntil(claimed, until);
  }
  return claimed;
}

/** The credit was actually seen - by an admin in the payments queue, or by the
 * confirm webhook. This is what turns three days into a month.
 *
 * Accepts an unclaimed order too: someone can pay and close the tab without
 * ever tapping "I've paid", and the money still arrived. */
export async function confirmOrder(id: string, by: string): Promise<PaymentOrder> {
  const order = await getOrder(id);
  if (!order) throw new PaymentOrderNotFoundError(id);
  if (order.status === "confirmed") return order; // Safe to retry the webhook.
  if (!canConfirm(order)) throw new PaymentOrderClosedError(id, order.status);

  const res = await pool.query<OrderRow>(
    `UPDATE payment_orders
        SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2,
            claimed_at = coalesce(claimed_at, now())
      WHERE id = $1 AND status IN ('pending', 'claimed')
      RETURNING *`,
    [id, by]
  );
  if (res.rows.length === 0) return (await getOrder(id))!;

  const confirmed = mapOrder(res.rows[0]);
  if (confirmed.tenantId) {
    const until = await grantLicense(confirmed.tenantId, "full", new Date(confirmed.claimedAt!), confirmed.plan);
    await giveNumberIfOwed(confirmed.tenantId);
    return recordLicensedUntil(confirmed, until);
  }
  return confirmed;
}

/** The other half of gating purchase on a confirmed payment.
 *
 * Signup hands out a pooled number to anyone who says they paid, but will not
 * BUY one on a claim alone - see acquireNumber. That leaves a business with a
 * confirmed payment and no number whenever the pool was empty, so this is where
 * it finally gets one, at the moment the money is known to have arrived.
 *
 * Best-effort and non-fatal: confirming a payment must still license the tenant
 * even if the carrier is having a bad day. It shouts, because a paid business
 * with no phone line is the thing this whole path exists to prevent.
 *
 * Imported lazily so that provisionTenant's dependencies - the Anthropic SDK
 * and the ingest path - do not get pulled into every route that touches
 * billing.ts, which is most of them. */
async function giveNumberIfOwed(tenantId: string): Promise<void> {
  try {
    const existing = await pool.query<{ voice_phone_number: string | null }>(
      "SELECT voice_phone_number FROM tenants WHERE id = $1",
      [tenantId]
    );
    if (existing.rows[0]?.voice_phone_number) return;

    const { acquireNumber } = await import("@/lib/provisionTenant");
    const e164 = await acquireNumber(tenantId, true);
    if (e164) {
      console.log(`[payment-confirm] ${tenantId} paid and confirmed - assigned ${e164}`);
    } else {
      console.error(
        `[payment-confirm] ${tenantId} has a CONFIRMED payment but could not be given a number. ` +
          `Assign one from /admin/numbers.`
      );
    }
  } catch (err) {
    console.error(`[payment-confirm] number acquisition failed for confirmed tenant ${tenantId}:`, err);
  }
}

/** The credit did not arrive. Ends the provisional licence at once rather than
 * letting the rest of the three days run - the whole point of a short window is
 * that a wrong call is cheap to correct in either direction. */
export async function rejectOrder(id: string): Promise<PaymentOrder> {
  const order = await getOrder(id);
  if (!order) throw new PaymentOrderNotFoundError(id);
  if (!canConfirm(order)) throw new PaymentOrderClosedError(id, order.status);

  const res = await pool.query<OrderRow>(
    `UPDATE payment_orders SET status = 'rejected', confirmed_at = now()
      WHERE id = $1 AND status IN ('pending', 'claimed') RETURNING *`,
    [id]
  );
  if (res.rows.length === 0) return (await getOrder(id))!;

  const rejected = mapOrder(res.rows[0]);
  if (rejected.tenantId) await expireLicenseNow(rejected.tenantId);
  return rejected;
}

/** Ties a signup order to the tenant it paid for, once provisioning has
 * created it. Also what stops liveOrderForMobile handing the same paid order to
 * a second signup: a signup order with a tenant is spent. */
export async function attachTenantToOrder(id: string, tenantId: string): Promise<void> {
  await pool.query("UPDATE payment_orders SET tenant_id = $2 WHERE id = $1", [id, tenantId]);
}

async function recordLicensedUntil(order: PaymentOrder, until: string): Promise<PaymentOrder> {
  await pool.query("UPDATE payment_orders SET licensed_until = $2 WHERE id = $1", [order.id, until]);
  return { ...order, licensedUntil: until };
}

export async function setOrderLicensedUntil(id: string, until: string): Promise<void> {
  await pool.query("UPDATE payment_orders SET licensed_until = $2 WHERE id = $1", [id, until]);
}

/** Orders a human still has to do something about, newest first, plus enough
 * recent history to see what was already dealt with. */
export async function listOrders(limit = 100): Promise<(PaymentOrder & { businessName: string | null })[]> {
  const res = await pool.query<OrderRow & { business_name: string | null }>(
    `SELECT o.*, t.name AS business_name
       FROM payment_orders o
       LEFT JOIN tenants t ON t.id = o.tenant_id
      ORDER BY (o.status IN ('claimed', 'pending')) DESC, o.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows.map((row) => ({ ...mapOrder(row), businessName: row.business_name }));
}

/** Finds the order a bank credit belongs to. The reference is the id we put in
 * the UPI note; the UTR is what the payer typed when they claimed. */
export async function findOrderByReference(reference: string): Promise<PaymentOrder | null> {
  const res = await pool.query<OrderRow>(
    "SELECT * FROM payment_orders WHERE id = $1 OR utr = $1 ORDER BY created_at DESC LIMIT 1",
    [reference]
  );
  return res.rows[0] ? mapOrder(res.rows[0]) : null;
}

/** Records a provider webhook, and says whether this is the first time we have
 * seen it.
 *
 * The insert IS the idempotency gate: `on conflict do nothing` succeeds exactly
 * once per id, so the caller acts only when this returns true. A gateway
 * retries anything it did not get a 2xx for, and a retried charge event that
 * ran twice would read as two periods paid for.
 *
 * `payload` is the raw body string, cast to jsonb rather than re-serialised
 * from a parsed object - a webhook is the only record of a charge we did not
 * initiate, so what is stored should be exactly what arrived. */
export async function recordWebhookEvent(input: {
  id: string;
  provider: string;
  type: string;
  rawPayload: string;
}): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO webhook_events (id, provider, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [input.id, input.provider, input.type, input.rawPayload]
  );
  return res.rowCount !== null && res.rowCount > 0;
}

export interface ResolvedPlan {
  plan: Plan;
  planId: string;
  /** What Cashfree will actually charge. This, not the configured price, is
   * what the signup page shows - the gateway is the thing that moves money, so
   * it is the only honest number to put in front of a payer. */
  amountPaise: number;
  /** What platform_settings says. Differs only if someone edited one side. */
  configuredAmountPaise: number;
  /** True when those two disagree. Not fatal to rendering a price - the page
   * shows Cashfree's - but it means the marketing page is advertising
   * something else, which is exactly the drift the price was moved into
   * platform_settings to prevent. */
  mismatch: boolean;
  intervalType: PlanIntervalType | null;
}

/** Both plans, as Cashfree actually holds them.
 *
 * Which plan is monthly and which is annual comes from planKind() reading
 * plan_interval_type - never from the configured order or the plan's name. */
export async function resolvePlans(): Promise<ResolvedPlan[]> {
  const config = await getBillingConfig();
  const wanted: { plan: Plan; planId: string | null; configuredAmountPaise: number }[] = [
    { plan: "monthly", planId: config.planIdMonthly, configuredAmountPaise: config.amountPaise },
    { plan: "annual", planId: config.planIdAnnual, configuredAmountPaise: config.annualAmountPaise },
  ];

  const resolved: ResolvedPlan[] = [];
  for (const want of wanted) {
    if (!want.planId) continue;
    const fetched = await getPlan(want.planId);
    const kind = planKind(fetched);
    // The id configured under "monthly" charging by the year is a
    // misconfiguration that would put the wrong price under the wrong heading.
    // Refused outright rather than displayed.
    if (kind && kind !== want.plan) {
      throw new Error(
        `Cashfree plan ${want.planId} is configured as the ${want.plan} plan but bills ` +
          `${fetched.plan_interval_type}. Fix the plan ids in /admin before anyone can pay.`
      );
    }
    const amountPaise = planToPaise(fetched) ?? want.configuredAmountPaise;
    const mismatch = amountPaise !== want.configuredAmountPaise;
    if (mismatch) {
      console.error(
        `[billing] price drift: Cashfree plan ${want.planId} charges ${amountPaise} paise, ` +
          `platform_settings says ${want.configuredAmountPaise}. The site is advertising a ` +
          `price it will not charge.`
      );
    }
    resolved.push({
      plan: want.plan,
      planId: want.planId,
      amountPaise,
      configuredAmountPaise: want.configuredAmountPaise,
      mismatch,
      intervalType: fetched.plan_interval_type ?? null,
    });
  }
  return resolved;
}

export class PaymentOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment order not found: ${id}`);
    this.name = "PaymentOrderNotFoundError";
  }
}

export class PaymentOrderClosedError extends Error {
  constructor(id: string, status: OrderStatus) {
    super(`Payment order ${id} is ${status === "expired" ? "no longer valid" : status}`);
    this.name = "PaymentOrderClosedError";
  }
}

export interface PaymentInstructions {
  orderId: string;
  vpa: string;
  payeeName: string;
  amountPaise: number;
  upiUri: string;
  qrDataUrl: string;
  qrExpiresAt: string;
  status: OrderStatus;
}

/** Everything the payment screen needs, composed server-side. The browser is
 * shown the QR and the deep link but never gets to decide what is in them. */
export async function paymentInstructions(order: PaymentOrder): Promise<PaymentInstructions> {
  const upiUri = buildUpiUri({
    vpa: order.vpa,
    payeeName: order.payeeName,
    amountPaise: order.amountPaise,
    orderId: order.id,
  });
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });
  return {
    orderId: order.id,
    vpa: order.vpa,
    payeeName: order.payeeName,
    amountPaise: order.amountPaise,
    upiUri,
    qrDataUrl,
    qrExpiresAt: order.qrExpiresAt,
    status: order.status,
  };
}
