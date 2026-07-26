"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Kiowa Badge - small count or dot indicator. Wrap an element to anchor it.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface BadgeProps {
  count?: number | string;
  dot?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Badge({ count, dot = false, children, style }: BadgeProps) {
  const badge = (
    <span
      style={{
        minWidth: dot ? 6 : 16, height: dot ? 6 : 16, padding: dot ? 0 : "0 4px",
        borderRadius: "var(--radius-full)", background: "var(--color-error)", color: "var(--color-on-error)",
        fontFamily: "var(--font-ui)", fontSize: 11, fontWeight: "var(--weight-medium)" as unknown as number,
        display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
      }}
    >
      {dot ? "" : count}
    </span>
  );
  if (!children) return badge;
  return (
    <span style={{ position: "relative", display: "inline-flex", ...style }}>
      {children}
      <span style={{ position: "absolute", top: -4, right: -4 }}>{badge}</span>
    </span>
  );
}

export default Badge;
