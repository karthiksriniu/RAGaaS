"use client";

import { useState, type ChangeEvent, type CSSProperties, type TextareaHTMLAttributes } from "react";

/**
 * Multi-line text field matching TextField's visual language (border,
 * radius, focus color, floating label). Not part of the synced Kiowa
 * Design System component set - its ported TextField is single-line
 * (`<input>`) only - added at the app level for cases needing several
 * lines of freeform text (e.g. a tenant's admin-authored answer-style
 * guidance). Always floats its label (docked above the box) rather than
 * TextField's focus/fill-triggered float: a multi-line field is often
 * pre-filled with substantial text, so there's no useful "hint inside an
 * empty box" state to preserve.
 */
export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "style" | "onChange" | "value"> {
  label?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  error?: boolean;
  disabled?: boolean;
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  style?: CSSProperties;
}

export function Textarea({
  label,
  value,
  placeholder,
  rows = 8,
  error = false,
  disabled = false,
  onChange,
  style,
  ...rest
}: TextareaProps) {
  const [focused, setFocused] = useState(false);
  const [internal, setInternal] = useState(value || "");
  const val = value !== undefined ? value : internal;

  const accent = error ? "var(--color-error)" : focused ? "var(--color-primary)" : "var(--color-outline)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-ui)", ...style }}>
      {label && (
        <span
          style={{
            fontSize: 12, paddingLeft: 4,
            color: error ? "var(--color-error)" : focused ? "var(--color-primary)" : "var(--color-on-surface-variant)",
          }}
        >
          {label}
        </span>
      )}
      <textarea
        value={val}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => { setInternal(e.target.value); onChange?.(e); }}
        style={{
          width: "100%", resize: "vertical",
          borderRadius: "var(--radius-xs)",
          border: `${focused ? 2 : 1}px solid ${accent}`,
          padding: "12px 16px",
          background: "transparent",
          fontFamily: "var(--font-ui)", fontSize: 14, lineHeight: 1.5, color: "var(--color-on-surface)",
          opacity: disabled ? 0.38 : 1,
          outline: "none",
          transition: "border-color var(--duration-short) var(--ease-standard)",
        }}
        {...rest}
      />
    </div>
  );
}

export default Textarea;
