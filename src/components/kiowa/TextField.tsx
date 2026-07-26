"use client";

import { useState, type ChangeEvent, type CSSProperties, type InputHTMLAttributes } from "react";

/**
 * Kiowa TextField - Material 3 text field (filled or outlined).
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "style" | "onChange" | "value"> {
  label?: string;
  value?: string;
  placeholder?: string;
  variant?: "outlined" | "filled";
  leadingIcon?: string;
  trailingIcon?: string;
  supportingText?: string;
  error?: boolean;
  disabled?: boolean;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  style?: CSSProperties;
}

export function TextField({
  label,
  value,
  placeholder,
  variant = "outlined",
  leadingIcon,
  trailingIcon,
  supportingText,
  error = false,
  disabled = false,
  type = "text",
  autoFocus = false,
  onChange,
  style,
  ...rest
}: TextFieldProps) {
  // Initialized from autoFocus directly, rather than detected from the DOM
  // after mount: a native autoFocus input's own browser-driven focus can
  // land before or after an effect runs (a real, observed race), so instead
  // of racing it, just start in the state we already know the field will be
  // in.
  const [focused, setFocused] = useState(autoFocus);
  const [internal, setInternal] = useState(value || "");

  const val = value !== undefined ? value : internal;
  const filled = String(val).length > 0;
  // Date/time/etc. inputs render their own always-visible native
  // placeholder segments (e.g. "dd/mm/yyyy") regardless of value, which
  // would overlap a label sitting at vertical-center - keep the label
  // floated (docked at the top) for those instead of only on focus/fill.
  const alwaysFloatType = type === "date" || type === "time" || type === "datetime-local" || type === "month" || type === "week";
  const floated = focused || filled || alwaysFloatType;

  const accent = error ? "var(--color-error)" : focused ? "var(--color-primary)" : "var(--color-outline)";
  const isOutlined = variant === "outlined";

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-ui)", minWidth: 220, ...style }}>
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 12,
          height: 56,
          padding: "0 16px",
          borderRadius: isOutlined ? "var(--radius-xs)" : "var(--radius-xs) var(--radius-xs) 0 0",
          border: isOutlined ? `${focused ? 2 : 1}px solid ${accent}` : "none",
          borderBottom: `${focused ? 2 : 1}px solid ${accent}`,
          background: isOutlined ? "transparent" : "var(--color-surface-container-highest)",
          opacity: disabled ? 0.38 : 1,
          transition: "border-color var(--duration-short) var(--ease-standard)",
        }}
      >
        {leadingIcon && <span className="material-symbols-rounded" style={{ fontSize: 20, color: "var(--color-on-surface-variant)" }}>{leadingIcon}</span>}
        <div style={{ position: "relative", flex: 1, height: "100%" }}>
          {label && (
            <label
              style={{
                position: "absolute", left: 0,
                top: floated ? (isOutlined ? -28 : 6) : "50%",
                transform: floated ? "none" : "translateY(-50%)",
                fontSize: floated ? 12 : 16,
                color: error ? "var(--color-error)" : focused ? "var(--color-primary)" : "var(--color-on-surface-variant)",
                background: isOutlined && floated ? "var(--color-surface)" : "transparent",
                padding: isOutlined && floated ? "0 4px" : 0,
                pointerEvents: "none",
                transition: "all var(--duration-short) var(--ease-standard)",
              }}
            >
              {label}
            </label>
          )}
          <input
            type={type}
            value={val}
            placeholder={floated ? placeholder : ""}
            disabled={disabled}
            autoFocus={autoFocus}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => { setInternal(e.target.value); onChange?.(e); }}
            style={{
              width: "100%", height: "100%", border: "none", outline: "none", background: "transparent",
              fontFamily: "var(--font-ui)", fontSize: 16, color: "var(--color-on-surface)",
              paddingTop: label && !isOutlined ? 14 : 0,
            }}
            {...rest}
          />
        </div>
        {trailingIcon && (
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: error ? "var(--color-error)" : "var(--color-on-surface-variant)" }}>
            {trailingIcon}
          </span>
        )}
      </div>
      {supportingText && (
        <span style={{ fontSize: 12, paddingLeft: 16, color: error ? "var(--color-error)" : "var(--color-on-surface-variant)" }}>
          {supportingText}
        </span>
      )}
    </div>
  );
}

export default TextField;
