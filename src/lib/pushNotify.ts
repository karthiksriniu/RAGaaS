import webpush from "web-push";
import { pool } from "@/lib/db";

// Browser push for the admin payments queue.
//
// The whole module is a no-op when VAPID keys are absent, which is the state
// every environment starts in. That is deliberate: a deployment without keys
// should behave exactly like one with no subscribers, not throw on a code path
// that runs inside a payment claim.

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Whether this deployment can send at all. */
export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/** The key the browser needs to subscribe. Public by design - it is handed to
 * every client that subscribes, and is useless without its private half. */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function configure(): void {
  webpush.setVapidDetails(
    // A contact address is required by the spec so a push service can reach
    // the sender about abuse. Falls back rather than throwing, because a
    // missing subject should not be the thing that breaks a payment claim.
    process.env.VAPID_SUBJECT || "mailto:hello@mybizcare.com",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );
}

export async function saveSubscription(sub: PushSubscriptionRecord, userAgent: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO admin_push_subscriptions (endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [sub.endpoint, sub.p256dh, sub.auth, userAgent]
  );
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await pool.query("DELETE FROM admin_push_subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function countSubscriptions(): Promise<number> {
  const res = await pool.query<{ n: string }>("SELECT count(*) AS n FROM admin_push_subscriptions");
  return parseInt(res.rows[0]?.n ?? "0", 10);
}

interface Payload {
  title: string;
  body: string;
  url?: string;
}

/** Sends to every subscribed browser, pruning the ones the push service says
 * are gone.
 *
 * 404 and 410 are the push service telling us a subscription is permanently
 * dead - the browser was reinstalled, or permission was revoked. Deleting on
 * anything else would throw away a live subscription over a transient 5xx, so
 * only those two prune. */
async function sendToAll(payload: Payload): Promise<{ sent: number; pruned: number }> {
  if (!pushConfigured()) return { sent: 0, pruned: 0 };
  configure();

  const subs = await pool.query<PushSubscriptionRecord>(
    "SELECT endpoint, p256dh, auth FROM admin_push_subscriptions"
  );
  if (subs.rows.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;

  await Promise.all(
    subs.rows.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          // Six hours. A provisional licence lasts three days, so a push that
          // arrives when the phone comes back online this evening is still
          // useful; one that arrives tomorrow is just confusing.
          { TTL: 6 * 60 * 60 }
        );
        sent++;
        await pool.query(
          "UPDATE admin_push_subscriptions SET last_success_at = now() WHERE endpoint = $1",
          [s.endpoint]
        );
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          await deleteSubscription(s.endpoint);
          pruned++;
        } else {
          console.error(`[push] send failed (status ${status ?? "?"}):`, err);
        }
      }
    })
  );

  return { sent, pruned };
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

/** A payer has said they paid. Somebody has to look at the bank app.
 *
 * Best-effort and never throws: this runs inside claimOrder, and a push service
 * having a bad day must not fail a payment claim or cost the payer their
 * provisional licence. */
/** How long the whole notification attempt gets before the caller moves on.
 *
 * This is awaited inside claimOrder, which runs while the payer is watching a
 * spinner. web-push sets no timeout of its own, so without this a push service
 * that stops responding would hold the payer's request open until the platform
 * killed it - turning "your notification was late" into "their payment failed".
 * Sends already in flight are not cancelled; we simply stop waiting. */
const SEND_BUDGET_MS = 4000;

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T | void> {
  return Promise.race([
    work,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        onTimeout();
        resolve();
      }, ms)
    ),
  ]);
}

export async function notifyPaymentAwaitingConfirmation(order: {
  id: string;
  mobile: string;
  amountPaise: number;
  purpose: string;
  tenantId: string | null;
}): Promise<void> {
  try {
    if (!pushConfigured()) return;

    // The business name if we have one. A signup order has no tenant until
    // provisioning finishes, so the mobile is the only handle then - and it is
    // the handle the admin will match against their bank app anyway.
    let who = order.mobile;
    if (order.tenantId) {
      const r = await pool.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [
        order.tenantId,
      ]);
      if (r.rows[0]?.name) who = r.rows[0].name;
    }

    const result = await withTimeout(
      sendToAll({
        title: `${rupees(order.amountPaise)} to confirm`,
        body: `${who} says they have paid (${order.purpose}). Check the bank app, then confirm.`,
        url: "/admin/billing",
      }),
      SEND_BUDGET_MS,
      () => console.error(`[push] payment ${order.id}: gave up waiting after ${SEND_BUDGET_MS}ms`)
    );
    if (result) {
      console.log(`[push] payment ${order.id}: notified ${result.sent} device(s), pruned ${result.pruned}`);
    }
  } catch (err) {
    console.error("[push] notification failed for payment", order.id, err);
  }
}
