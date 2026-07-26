"use client";

import type { CSSProperties } from "react";

/**
 * Kiowa StatusPill - a compact status / urgency indicator.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface StatusPillProps {
  label: string;
  tone?: "neutral" | "primary" | "urgent" | "success" | "info";
  style?: CSSProperties;
}

const TONES: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: "var(--color-surface-container-highest)", fg: "var(--color-on-surface-variant)" },
  primary: { bg: "var(--color-primary-container)", fg: "var(--color-on-primary-container)" },
  urgent: { bg: "var(--color-error-container)", fg: "var(--color-on-error-container)" },
  success: { bg: "var(--color-secondary-container)", fg: "var(--color-on-secondary-container)" },
  info: { bg: "var(--color-tertiary-container)", fg: "var(--color-on-tertiary-container)" },
};

export function StatusPill({ label, tone = "neutral", style }: StatusPillProps) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px",
        borderRadius: "var(--radius-sm)", background: t.bg, color: t.fg,
        fontFamily: "var(--font-ui)", fontSize: 12, fontWeight: "var(--weight-medium)" as unknown as number, letterSpacing: "0.1px",
        whiteSpace: "nowrap", ...style,
      }}
    >
      {tone === "urgent" && <span className="material-symbols-rounded fill" style={{ fontSize: 14 }}>flag</span>}
      {label}
    </span>
  );
}

export default StatusPill;
