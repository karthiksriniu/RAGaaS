"use client";

import { useState, type ButtonHTMLAttributes, type CSSProperties } from "react";

/**
 * Kiowa IconButton - Material 3 icon button.
 * Styles: standard · filled · tonal · outlined. Optional toggle (selected).
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  icon: string;
  variant?: "standard" | "filled" | "tonal" | "outlined";
  size?: number;
  selected?: boolean;
  filledIcon?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  style?: CSSProperties;
}

export function IconButton({
  icon,
  variant = "standard",
  size = 40,
  selected = false,
  disabled = false,
  filledIcon = false,
  onClick,
  "aria-label": ariaLabel,
  style,
  ...rest
}: IconButtonProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const palettes: Record<string, { bg: string; fg: string; border: string }> = {
    standard: selected
      ? { bg: "transparent", fg: "var(--color-primary)", border: "none" }
      : { bg: "transparent", fg: "var(--color-on-surface-variant)", border: "none" },
    filled: selected || variant === "filled"
      ? { bg: "var(--color-primary)", fg: "var(--color-on-primary)", border: "none" }
      : { bg: "var(--color-surface-container-highest)", fg: "var(--color-primary)", border: "none" },
    tonal: { bg: "var(--color-secondary-container)", fg: "var(--color-on-secondary-container)", border: "none" },
    outlined: { bg: "transparent", fg: "var(--color-on-surface-variant)", border: "1px solid var(--color-outline)" },
  };
  const p = palettes[variant] || palettes.standard;
  const stateOpacity = active ? 0.12 : hover ? 0.08 : 0;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={selected || undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        border: p.border,
        borderRadius: "var(--radius-full)",
        background: p.bg,
        color: p.fg,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.38 : 1,
        padding: 0,
        transition: "background var(--duration-short) var(--ease-standard)",
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          position: "absolute", inset: 0, borderRadius: "inherit",
          background: p.fg, opacity: stateOpacity, pointerEvents: "none",
          transition: "opacity var(--duration-short) var(--ease-standard)",
        }}
      />
      <span
        className={`material-symbols-rounded${(filledIcon || selected) ? " fill" : ""}`}
        style={{ fontSize: Math.round(size * 0.6), lineHeight: 1, position: "relative" }}
      >
        {icon}
      </span>
    </button>
  );
}

export default IconButton;
