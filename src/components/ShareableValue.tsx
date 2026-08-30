"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "./kiowa/Button";
import { Card } from "./kiowa/Card";

/**
 * One thing a business hands to its customers - a phone number, a chat link -
 * shown large with the ways to pass it on.
 *
 * Copy is always present; Share is not. The Web Share API needs a real user
 * gesture and simply does not exist on desktop Firefox, so it is detected in an
 * effect (never during render, which would differ between server and client and
 * blow up hydration) and left out entirely where unsupported. Copy is therefore
 * the route that always works, and Share is a shortcut on the phones where this
 * page is most likely to be open.
 */
export interface ShareableValueProps {
  /** Small label above the value, e.g. "Your phone number". */
  label: string;
  /** The value as a customer would use it. Copied and shared verbatim. */
  value: string | null;
  /** Shown instead of the value when there isn't one yet. */
  placeholder?: string;
  hint?: string;
  /** Set for a link, so it can also be opened. */
  href?: string;
  /** Subject line for the OS share sheet. */
  shareTitle?: string;
  /** Sentence the share sheet pre-fills. Falls back to the bare value. */
  shareText?: string;
  icon: string;
}

/** Share support cannot change for the life of the page, so there is nothing
 * to subscribe to. */
const subscribeToNothing = () => () => {};

export function ShareableValue({
  label,
  value,
  placeholder = "Not ready yet",
  hint,
  href,
  shareTitle,
  shareText,
  icon,
}: ShareableValueProps) {
  const [flash, setFlash] = useState<string | null>(null);

  // useSyncExternalStore, not an effect: the server has no navigator, so the
  // server snapshot is a hard false and the client's real answer arrives during
  // hydration without a second render pass or a mismatched first paint. A lazy
  // useState initialiser would read navigator during SSR and disagree with the
  // client; an effect would set state synchronously in its body.
  const canShare = useSyncExternalStore(
    subscribeToNothing,
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false
  );

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setFlash("Copied");
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // in-app browsers. Say so, rather than flashing a success that did not
      // happen - the value is on screen and can be selected by hand.
      setFlash("Could not copy — select it above");
    }
  }

  async function share() {
    if (!value) return;
    try {
      await navigator.share({
        title: shareTitle,
        text: shareText ?? value,
        ...(href ? { url: href } : {}),
      });
    } catch (err) {
      // Dismissing the share sheet rejects with AbortError. That is a person
      // changing their mind, not a failure worth reporting to them.
      if (err instanceof Error && err.name !== "AbortError") setFlash("Could not open sharing");
    }
  }

  return (
    <Card variant="outlined" padding={24}>
      <div className="flex items-start gap-3">
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 22, color: "var(--color-primary)" }}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
            {label}
          </p>
          {/* break-all, because a tenant subdomain plus the root domain is
              easily wider than a phone screen and must wrap rather than push
              the card sideways. */}
          <p
            className="kw-headline-small mt-1"
            style={{ wordBreak: "break-all", color: value ? "var(--color-on-surface)" : "var(--color-on-surface-variant)" }}
          >
            {value ?? placeholder}
          </p>
          {hint && (
            <p className="kw-body-small mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
              {hint}
            </p>
          )}

          {value && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="tonal" size="small" icon="content_copy" onClick={copy}>
                Copy
              </Button>
              {canShare && (
                <Button variant="outlined" size="small" icon="share" onClick={share}>
                  Share
                </Button>
              )}
              {href && (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  <Button variant="text" size="small" icon="open_in_new">
                    Open
                  </Button>
                </a>
              )}
              {flash && (
                <span className="kw-body-small" style={{ color: "var(--color-primary)" }}>
                  {flash}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default ShareableValue;
