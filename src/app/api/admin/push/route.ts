import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import {
  countSubscriptions,
  deleteSubscription,
  pushConfigured,
  saveSubscription,
  vapidPublicKey,
} from "@/lib/pushNotify";

export const runtime = "nodejs";

// Subscription management for admin payment alerts. Gated by proxy.ts like
// every /api/admin route, and re-checked here the way the other admin routes
// do - the proxy is the fence, this is the lock.

/** What the browser needs to subscribe, and whether it is worth offering.
 *
 * The public key is public by definition: it is handed to every subscriber and
 * is useless without its private half. Served from here rather than baked in as
 * NEXT_PUBLIC_* so that setting the keys on a deployment does not require a
 * rebuild to take effect. */
export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const configured = pushConfigured();
  return NextResponse.json({
    configured,
    publicKey: vapidPublicKey(),
    // So the page can say "2 devices" rather than leaving someone wondering
    // whether the phone they set up last week is still subscribed.
    subscriptions: configured ? await countSubscriptions() : 0,
  });
}

/** Registers this browser. The body is the browser's own PushSubscription,
 * JSON-serialised - we store the three fields needed to send to it. */
export async function POST(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) {
    return NextResponse.json(
      { error: "Push is not configured on this deployment (VAPID keys are unset)." },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";

  // All three or nothing: a row missing a key can never be sent to, and would
  // sit there forever looking like a working subscription.
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Incomplete push subscription" }, { status: 400 });
  }
  // Push endpoints are https URLs from the browser's push service. Anything
  // else is not something we should be storing, let alone POSTing to later.
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return NextResponse.json({ error: "Invalid push endpoint" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" || endpoint.length > 2000) {
    return NextResponse.json({ error: "Invalid push endpoint" }, { status: 400 });
  }

  await saveSubscription(
    { endpoint, p256dh, auth },
    // Only so a person can tell one device from another later. Truncated
    // because a UA string is long and none of it matters past that.
    (req.headers.get("user-agent") || "").slice(0, 300) || null
  );
  return NextResponse.json({ ok: true, subscriptions: await countSubscriptions() });
}

/** Forgets this browser. Called when the admin turns alerts off. */
export async function DELETE(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });

  await deleteSubscription(endpoint);
  return NextResponse.json({ ok: true, subscriptions: await countSubscriptions() });
}
