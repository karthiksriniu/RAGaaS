"use client";

import type { CSSProperties } from "react";

/**
 * Kiowa ProgressIndicator - Material 3 linear or circular progress.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface ProgressIndicatorProps {
  variant?: "linear" | "circular";
  value?: number;
  size?: number;
  thickness?: number;
  style?: CSSProperties;
}

export function ProgressIndicator({ variant = "linear", value, size = 48, thickness = 4, style }: ProgressIndicatorProps) {
  const indeterminate = value == null;
  if (variant === "circular") {
    const r = (size - thickness) / 2;
    const c = 2 * Math.PI * r;
    return (
      <svg
        width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ ...(indeterminate ? { animation: "kw-spin 1.2s linear infinite" } : {}), ...style }}
      >
        <style>{"@keyframes kw-spin{to{transform:rotate(360deg)}}"}</style>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-variant)" strokeWidth={thickness} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-primary)" strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={indeterminate ? c * 0.75 : c * (1 - (value ?? 0))} transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    );
  }
  return (
    <div style={{ position: "relative", height: thickness, borderRadius: "var(--radius-full)", background: "var(--color-surface-variant)", overflow: "hidden", ...style }}>
      <div
        style={{
          position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: "inherit", background: "var(--color-primary)",
          width: indeterminate ? "40%" : `${(value ?? 0) * 100}%`,
          animation: indeterminate ? "kw-bar 1.6s var(--ease-standard) infinite" : "none",
        }}
      />
      <style>{"@keyframes kw-bar{0%{left:-40%}100%{left:100%}}"}</style>
    </div>
  );
}

export default ProgressIndicator;
