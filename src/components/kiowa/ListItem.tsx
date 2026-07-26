"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Kiowa ListItem - Material 3 list item with leading/trailing slots.
 * Used for menus, file rows, contact rows, etc.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface ListItemProps {
  headline: ReactNode;
  supportingText?: ReactNode;
  overline?: string;
  leading?: ReactNode;
  leadingIcon?: string;
  trailing?: ReactNode;
  trailingIcon?: string;
  trailingText?: string;
  selected?: boolean;
  lines?: 1 | 2 | 3;
  onClick?: () => void;
  style?: CSSProperties;
}

export function ListItem({
  headline,
  supportingText,
  overline,
  leading,
  leadingIcon,
  trailing,
  trailingIcon,
  trailingText,
  selected = false,
  lines = 1,
  onClick,
  style,
}: ListItemProps) {
  const [hover, setHover] = useState(false);
  const minH = lines >= 3 ? 88 : lines === 2 ? 72 : 56;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", display: "flex", alignItems: "center", gap: 16,
        minHeight: minH, padding: "8px 16px",
        background: selected ? "var(--color-secondary-container)" : "transparent",
        cursor: onClick ? "pointer" : "default", fontFamily: "var(--font-ui)", ...style,
      }}
    >
      {onClick && <span style={{ position: "absolute", inset: 0, background: "var(--color-on-surface)", opacity: hover ? 0.05 : 0, pointerEvents: "none" }} />}
      {leading}
      {leadingIcon && !leading && <span className="material-symbols-rounded" style={{ fontSize: 24, color: "var(--color-on-surface-variant)" }}>{leadingIcon}</span>}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2, position: "relative" }}>
        {overline && <span style={{ fontSize: 11, letterSpacing: "0.5px", color: "var(--color-on-surface-variant)" }}>{overline}</span>}
        <span style={{ fontSize: 16, color: "var(--color-on-surface)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: lines === 1 ? "nowrap" : "normal" }}>{headline}</span>
        {supportingText && (
          <span
            style={{
              fontSize: 14, color: "var(--color-on-surface-variant)", overflow: "hidden", textOverflow: "ellipsis",
              display: "-webkit-box", WebkitLineClamp: lines >= 3 ? 2 : 1, WebkitBoxOrient: "vertical",
            }}
          >
            {supportingText}
          </span>
        )}
      </div>
      {trailingText && <span style={{ fontSize: 11, color: "var(--color-on-surface-variant)", position: "relative", whiteSpace: "nowrap" }}>{trailingText}</span>}
      {trailing}
      {trailingIcon && !trailing && <span className="material-symbols-rounded" style={{ fontSize: 24, color: "var(--color-on-surface-variant)", position: "relative" }}>{trailingIcon}</span>}
    </div>
  );
}

export default ListItem;
