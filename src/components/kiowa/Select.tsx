"use client";

import { useState, type CSSProperties } from "react";

/**
 * Kiowa Select - Material 3 outlined dropdown trigger with a simple menu.
 * Ported from the Kiowa Design System (claude.ai/design) component source.
 */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  value?: string;
  options?: Array<string | SelectOption>;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  style?: CSSProperties;
}

export function Select({ label, value, options = [], placeholder = "Select", disabled = false, onChange, style }: SelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => (typeof o === "string" ? o : o.value) === value);
  const selectedLabel = selected ? (typeof selected === "string" ? selected : selected.label) : "";

  return (
    <div style={{ position: "relative", display: "inline-flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-ui)", minWidth: 220, ...style }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          height: 56, padding: "0 16px", borderRadius: "var(--radius-xs)",
          border: `${open ? 2 : 1}px solid ${open ? "var(--color-primary)" : "var(--color-outline)"}`,
          background: "transparent", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.38 : 1,
          fontFamily: "var(--font-ui)", fontSize: 16, color: "var(--color-on-surface)", textAlign: "left",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
          {label && <span style={{ fontSize: 12, color: open ? "var(--color-primary)" : "var(--color-on-surface-variant)" }}>{label}</span>}
          <span
            style={{
              color: selectedLabel ? "var(--color-on-surface)" : "var(--color-on-surface-variant)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%",
            }}
          >
            {selectedLabel || placeholder}
          </span>
        </span>
        <span
          className="material-symbols-rounded"
          style={{ fontSize: 24, color: "var(--color-on-surface-variant)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--duration-short)", flexShrink: 0 }}
        >
          arrow_drop_down
        </span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: 60, left: 0, right: 0, zIndex: 20,
            background: "var(--color-surface-container)", borderRadius: "var(--radius-xs)",
            boxShadow: "var(--elevation-2)", padding: "8px 0", maxHeight: 280, overflowY: "auto",
          }}
        >
          {options.map((o) => {
            const v = typeof o === "string" ? o : o.value;
            const l = typeof o === "string" ? o : o.label;
            const isSel = v === value;
            return (
              <div
                key={v}
                onClick={() => { onChange?.(v); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                  height: 48, padding: "0 16px", cursor: "pointer", fontSize: 14,
                  background: isSel ? "var(--color-secondary-container)" : "transparent",
                  color: "var(--color-on-surface)",
                }}
                onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "var(--color-surface-container-high)"; }}
                onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
              >
                {l}
                {isSel && <span className="material-symbols-rounded" style={{ fontSize: 20, color: "var(--color-on-secondary-container)" }}>check</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default Select;
