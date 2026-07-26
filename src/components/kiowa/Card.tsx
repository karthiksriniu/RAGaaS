"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Kiowa Card - Material 3 container. Variants: elevated · filled · outlined.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface CardProps {
  children?: ReactNode;
  variant?: "elevated" | "filled" | "outlined";
  interactive?: boolean;
  selected?: boolean;
  padding?: number;
  onClick?: () => void;
  style?: CSSProperties;
  className?: string;
}

const VARIANTS: Record<string, { bg: string; border: string; shadow: string }> = {
  elevated: { bg: "var(--color-surface-container-low)", border: "none", shadow: "var(--elevation-1)" },
  filled: { bg: "var(--color-surface-container-highest)", border: "none", shadow: "none" },
  outlined: { bg: "var(--color-surface)", border: "1px solid var(--color-outline-variant)", shadow: "none" },
};

export function Card({ children, variant = "outlined", interactive = false, selected = false, padding = 16, onClick, style, className }: CardProps) {
  const [hover, setHover] = useState(false);
  const v = VARIANTS[variant] || VARIANTS.outlined;
  return (
    <div
      className={className}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", borderRadius: "var(--radius-md)",
        background: selected ? "var(--color-secondary-container)" : v.bg,
        border: v.border,
        boxShadow: interactive && hover && variant === "elevated" ? "var(--elevation-2)" : v.shadow,
        padding, cursor: interactive ? "pointer" : "default",
        transition: "box-shadow var(--duration-medium) var(--ease-standard), background var(--duration-short)",
        ...style,
      }}
    >
      {interactive && (
        <span style={{ position: "absolute", inset: 0, borderRadius: "inherit", background: "var(--color-on-surface)", opacity: hover ? 0.05 : 0, pointerEvents: "none" }} />
      )}
      {children}
    </div>
  );
}

export default Card;
