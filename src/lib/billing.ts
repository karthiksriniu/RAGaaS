import QRCode from "qrcode";
import { pool } from "@/lib/db";
import { grantLicense, expireLicenseNow } from "@/lib/tenants";
import {
  PLAN_PRICE_INR,
  QR_TTL_MINUTES,
  buildUpiUri,
  canClaim,
  canConfirm,
  newOrderId,
  type OrderPurpose,
  type OrderStatus,
} from "@/lib/upi";

// The DB-backed half of billing: platform configuration, the payment order
// lifecycle, and the licence each stage of it grants. The pure half - prices,
// the UPI deep link, the state machine's guards - is in upi.ts.

export interface BillingConfig {
  vpa: string;
  payeeName: string;
  priceInr: number;
  amountPaise: number;
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
    [["upi_vpa", "upi_payee_name", "plan_price_inr"]]
  );
  const settings = new Map(rows.rows.map((r) => [r.key, r.value]));

  const priceRaw = settings.get("plan_price_inr") || process.env.PLAN_PRICE_INR || "";
  const parsed = parseInt(priceRaw, 10);
  const priceInr = Number.isFinite(parsed) && parsed > 0 ? parsed : PLAN_PRICE_INR;

  return {
    vpa: settings.get("upi_vpa") || process.env.UPI_VPA || "",
    payeeName: settings.get("upi_payee_name") || process.env.UPI_PAYEE_NAME || "MyBizCare",
    priceInr,
    amountPaise: priceInr * 100,
  };
}

export async function updateBillingConfig(patch: Partial<Record<
  "upi_vpa" | "upi_payee_name" | "plan_price_inr", string
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
}): Promise<PaymentOrder> {
  const existing = await liveOrderForMobile(input.mobile, input.purpose);
  if (existing) return existing;

  const config = await getBillingConfig();
  if (!config.vpa) throw new Error("No UPI VPA is configured - set it in /admin");

  const res = await pool.query<OrderRow>(
    `INSERT INTO payment_orders
       (id, mobile, tenant_id, purpose, amount_paise, vpa, payee_name, status, qr_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now() + $8::interval)
     RETURNING *`,
    [
      newOrderId(),
      input.mobile,
      input.tenantId ?? null,
      input.purpose,
      config.amountPaise,
      config.vpa,
      config.payeeName,
      `${QR_TTL_MINUTES} minutes`,
    ]
  );
  return mapOrder(res.rows[0]);
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
  if (claimed.tenantId) {
    const until = await grantLicense(claimed.tenantId, "provisional", new Date(claimed.claimedAt!));
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
    const until = await grantLicense(confirmed.tenantId, "full", new Date(confirmed.claimedAt!));
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
