"use client";

import { useEffect, useState } from "react";
import { Button } from "./kiowa/Button";
import { Card } from "./kiowa/Card";

/**
 * Turns browser push alerts on for THIS device.
 *
 * Per device, not per admin, because that is what a push subscription actually
 * is - the same person subscribing from a phone and a laptop should get both,
 * and there is no per-user admin login to hang it off anyway.
 *
 * Every failure mode says which one it is. "Notifications are off" covering
 * unsupported, blocked, and not-yet-configured would leave someone toggling a
 * switch that could never work.
 */
type State =
  | "loading"
  | "unsupported" // no service worker / push API in this browser
  | "unconfigured" // deployment has no VAPID keys
  | "blocked" // permission denied at the browser level
  | "off"
  | "on";

/** The VAPID key travels as base64url text and has to reach subscribe() as
 * bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function PaymentAlertsToggle() {
  const [state, setState] = useState<State>("loading");
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function look() {
      if (!supported()) {
        if (!cancelled) setState("unsupported");
        return;
      }
      try {
        const res = await fetch("/api/admin/push");
        // An expired admin session answers 401, and `configured` would then be
        // undefined - which would have this say "push is not set up on this
        // deployment", a statement that is both false and unactionable. The
        // page itself redirects to the login on 401, so staying on "Checking…"
        // is the honest thing to show in the moment before it does.
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled) return;
        setDevices(d.subscriptions ?? 0);
        if (!d.configured) {
          setState("unconfigured");
          return;
        }
        if (Notification.permission === "denied") {
          setState("blocked");
          return;
        }
        // Registering here rather than only on the button is what lets a
        // returning visit report "on" without asking for anything.
        const reg = await navigator.serviceWorker.register("/sw.js");
        const existing = await reg.pushManager.getSubscription();
        if (!cancelled) setState(existing ? "on" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    }

    void look();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setError(null);
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }

      const keyRes = await fetch("/api/admin/push");
      const { publicKey } = await keyRes.json();
      if (!publicKey) throw new Error("This deployment has no push key configured.");

      const reg = await navigator.serviceWorker.register("/sw.js");
      // Waiting for the registration to be usable: subscribing against a worker
      // that is still installing throws on some Android builds.
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        // Chrome refuses a subscription that could deliver silently, and this
        // is a notification anyway - nothing here happens invisibly.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const res = await fetch("/api/admin/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not register this device");
      setDevices(d.subscriptions ?? 0);
      setState("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // Server first. If the browser forgets the subscription but the row
        // survives, we keep sending into a void until the push service says
        // 410; the other order just leaves a dead row for a moment.
        await fetch("/api/admin/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      setState("off");
      const res = await fetch("/api/admin/push");
      const d = await res.json().catch(() => ({}));
      setDevices(d.subscriptions ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const MESSAGE: Record<State, string> = {
    loading: "Checking…",
    unsupported:
      "This browser cannot show push notifications. On iPhone, add this site to your Home Screen first.",
    unconfigured: "Push is not set up on this deployment — VAPID keys are unset.",
    blocked:
      "Notifications are blocked for this site. Turn them back on in your browser's site settings, then reload.",
    off: "Get a notification on this device when someone says they have paid.",
    on: "On for this device.",
  };

  return (
    <Card variant="outlined" padding={20} className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="kw-title-medium">Payment alerts</p>
          <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
            {MESSAGE[state]}
            {state === "on" && devices > 1 ? ` ${devices} devices subscribed.` : ""}
          </p>
        </div>
        {state === "off" && (
          <Button variant="filled" size="small" icon="notifications" disabled={busy} onClick={enable}>
            {busy ? "Enabling…" : "Turn on"}
          </Button>
        )}
        {state === "on" && (
          <Button variant="outlined" size="small" icon="notifications_off" disabled={busy} onClick={disable}>
            {busy ? "Turning off…" : "Turn off"}
          </Button>
        )}
      </div>
      {error && (
        <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
    </Card>
  );
}

export default PaymentAlertsToggle;
