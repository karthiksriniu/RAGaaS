"use client";

import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";

/**
 * Kiowa Button - Material 3 common button.
 * Styles: elevated · filled · tonal · outlined · text.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  variant?: "elevated" | "filled" | "tonal" | "outlined" | "text";
  size?: "small" | "medium" | "large";
  icon?: string;
  trailingIcon?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

const PALETTES: Record<string, { bg: string; fg: string; border: string; shadow: string; overlay: string }> = {
  filled: {
    bg: "var(--color-primary)", fg: "var(--color-on-primary)",
    border: "none", shadow: "none", overlay: "var(--color-on-primary)",
  },
  elevated: {
    bg: "var(--color-surface-container-low)", fg: "var(--color-primary)",
    border: "none", shadow: "var(--elevation-1)", overlay: "var(--color-primary)",
  },
  tonal: {
    bg: "var(--color-secondary-container)", fg: "var(--color-on-secondary-container)",
    border: "none", shadow: "none", overlay: "var(--color-on-secondary-container)",
  },
  outlined: {
    bg: "transparent", fg: "var(--color-primary)",
    border: "1px solid var(--color-outline)", shadow: "none", overlay: "var(--color-primary)",
  },
  text: {
    bg: "transparent", fg: "var(--color-primary)",
    border: "none", shadow: "none", overlay: "var(--color-primary)",
  },
};

export function Button({
  children,
  variant = "filled",
  size = "medium",
  icon,
  trailingIcon,
  disabled = false,
  fullWidth = false,
  type = "button",
  onClick,
  style,
  ...rest
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);

  const height = size === "small" ? 32 : size === "large" ? 48 : 40;
  const padX = size === "large" ? 32 : 24;
  const fontSize = size === "large" ? 16 : 14;

  const p = PALETTES[variant] || PALETTES.filled;
  const stateOpacity = active ? 0.12 : hover ? 0.08 : 0;

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        position: "relative",
        display: fullWidth ? "flex" : "inline-flex",
        width: fullWidth ? "100%" : undefined,
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        height,
        padding: `0 ${icon && !children ? height / 2 : padX}px`,
        border: p.border,
        borderRadius: "var(--radius-full)",
        background: p.bg,
        color: p.fg,
        boxShadow: disabled ? "none" : p.shadow,
        fontFamily: "var(--font-ui)",
        fontSize,
        fontWeight: "var(--weight-medium)" as unknown as number,
        letterSpacing: "0.1px",
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.38 : 1,
        whiteSpace: "nowrap",
        transition: "box-shadow var(--duration-medium) var(--ease-standard), background var(--duration-short) var(--ease-standard)",
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          position: "absolute", inset: 0, borderRadius: "inherit",
          background: p.overlay, opacity: stateOpacity,
          pointerEvents: "none", transition: "opacity var(--duration-short) var(--ease-standard)",
        }}
      />
      {icon && <span className="material-symbols-rounded" style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>}
      {children && <span style={{ position: "relative" }}>{children}</span>}
      {trailingIcon && <span className="material-symbols-rounded" style={{ fontSize: 18, lineHeight: 1 }}>{trailingIcon}</span>}
    </button>
  );
}

export default Button;
