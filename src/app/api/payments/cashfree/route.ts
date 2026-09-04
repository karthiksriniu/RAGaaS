import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordWebhookEvent } from "@/lib/billing";
import { cashfreeConfig, cashfreeConfigured, verifyWebhookSignature } from "@/lib/cashfree";

export const runtime = "nodejs";

/** Cashfree's webhook.
 *
 * RECEIVER ONLY, deliberately. It proves the request is Cashfree's, records it
 * once, and acknowledges. It does NOT yet move a licence.
 *
 * That is not an omission to tidy up later - it is the point. We do not yet
 * know what Cashfree names the event that means "a mandate debit succeeded",
 * and a handler written against a guessed event name either does nothing (the
 * harmless failure) or extends a licence on the wrong signal (the expensive
 * one). Recording every event with its `type` turns the first real webhook
 * Cashfree sends into the answer, and the dispatch below is then one small,
 * evidence-backed change.
 *
 * Until then a payment still licenses a tenant exactly as it does today: by an
 * admin confirming it, or by /api/payments/confirm. Nothing regresses. */
export async function POST(req: NextRequest) {
  // The raw body, BEFORE any parse. The signature covers the bytes Cashfree
  // sent, and JSON.parse -> JSON.stringify is a different string (spacing, key
  // order), so verifying against a re-serialised body rejects every genuine
  // webhook. There is a test asserting exactly this - see cashfree.test.ts.
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-webhook-timestamp") || "";
  const signature = req.headers.get("x-webhook-signature") || "";

  // Unverifiable is not the same as invalid, and must not be answered 200 -
  // acknowledging an event we could not authenticate is how a forged charge
  // gets treated as real. 503 also tells Cashfree to retry, so events that
  // arrive before the key is set are not lost.
  if (!cashfreeConfigured()) {
    console.error("[cashfree-webhook] refused: CASHFREE_SECRET_KEY is not set");
    return NextResponse.json({ error: "Payments are not configured" }, { status: 503 });
  }

  const { secretKey } = cashfreeConfig();
  const verdict = verifyWebhookSignature({ timestamp, rawBody, signature, secretKey });
  if (!verdict.ok) {
    // The reason is logged but never returned: "stale" vs "mismatch" is useful
    // at 3am and is also a hint worth withholding from anyone probing.
    console.error(`[cashfree-webhook] rejected signature (${verdict.reason})`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    // Signed by us-and-Cashfree but not JSON. Nothing to retry into, so this is
    // a 400 rather than a 5xx - a redelivery would be identical.
    console.error("[cashfree-webhook] signed body was not JSON");
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }

  const type = eventType(event);

  // Keyed on a hash of the body rather than an id field, because which field
  // carries Cashfree's event id is one of the things this endpoint exists to
  // find out. A retry redelivers the same body, so the same key; two genuinely
  // different events differ somewhere in the payload (payment id, timestamps)
  // and so hash differently. Swap this for the real id once one is confirmed.
  const eventId = `cf_${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;

  let firstTime: boolean;
  try {
    firstTime = await recordWebhookEvent({
      id: eventId,
      provider: "cashfree",
      type,
      rawPayload: rawBody,
    });
  } catch (err) {
    // A 5xx makes Cashfree retry, which is what we want: an event we failed to
    // record is an event we have not handled.
    console.error("[cashfree-webhook] could not record event", eventId, err);
    return NextResponse.json({ error: "Could not record event" }, { status: 500 });
  }

  if (!firstTime) {
    console.log(`[cashfree-webhook] duplicate ${type} (${eventId}) - already recorded, ignoring`);
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // Deliberately loud, and deliberately at info level: these lines are the
  // record of what Cashfree actually names its events, which is what unblocks
  // the dispatch this route does not yet do.
  console.log(
    `[cashfree-webhook] recorded ${type} (${eventId}); top-level keys: ${topLevelKeys(event)}`
  );

  // Dispatch goes here, once the event names above are known. Acknowledged
  // regardless: an event we recorded but cannot yet act on must not be retried
  // forever, and it is safely on file in webhook_events either way.
  return NextResponse.json({ ok: true, type, eventId });
}

/** Cashfree's own name for what happened, if it is where we expect it.
 *
 * Not trusted beyond logging and storage: an unrecognised shape is recorded as
 * "unknown" rather than throwing, because losing an event we cannot classify is
 * worse than storing one we cannot name. */
function eventType(event: unknown): string {
  if (event && typeof event === "object") {
    const t = (event as Record<string, unknown>).type;
    if (typeof t === "string" && t) return t;
  }
  return "unknown";
}

function topLevelKeys(event: unknown): string {
  if (event && typeof event === "object") return Object.keys(event as object).join(",") || "(none)";
  return `(${typeof event})`;
}

/** So the URL can be confirmed reachable from a browser or a dashboard health
 * check while the webhook is being registered. Says nothing a caller does not
 * already know by having the URL. */
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "cashfree-webhook" });
}
