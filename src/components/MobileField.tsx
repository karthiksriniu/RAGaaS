"use client";

import { useState } from "react";

// Mobile number entry with the country code shown rather than typed.
//
// Every number in this product is Indian today, and asking people to type a
// country code they have never needed produced exactly the variants
// normalizeMobile has to clean up - "+91 98765 43210", "098765 43210",
// "919876543210". Showing "+91" as part of the field and accepting ten digits
// removes the ambiguity at the point where it starts, instead of correcting it
// afterwards.
//
// The country is a list with one entry rather than a hard-coded string, so
// supporting a second one is adding a row and showing a picker - not finding
// every place "+91" was inlined.

export interface Country {
  /** E.164 prefix, including the plus. */
  dialCode: string;
  name: string;
  /** How many digits follow the dial code. */
  nationalDigits: number;
}

export const COUNTRIES: Country[] = [
  { dialCode: "+91", name: "India", nationalDigits: 10 },
];

export const DEFAULT_COUNTRY = COUNTRIES[0];

export interface MobileFieldProps {
  label?: string;
  /** The national portion only - ten digits for India, no country code. */
  value: string;
  onChange: (nationalDigits: string) => void;
  country?: Country;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** The full E.164 number for a national-digits value. */
export function toE164(nationalDigits: string, country: Country = DEFAULT_COUNTRY): string {
  return `${country.dialCode}${nationalDigits}`;
}

export function MobileField({
  label = "Mobile number",
  value,
  onChange,
  country = DEFAULT_COUNTRY,
  disabled = false,
  autoFocus = false,
}: MobileFieldProps) {
  const [focused, setFocused] = useState(autoFocus);
  const accent = focused ? "var(--color-primary)" : "var(--color-outline)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-ui)" }}>
      <span
        style={{
          fontSize: 12,
          paddingLeft: 4,
          color: focused ? "var(--color-primary)" : "var(--color-on-surface-variant)",
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          borderRadius: "var(--radius-xs)",
          border: `${focused ? 2 : 1}px solid ${accent}`,
          // Compensate for the border growing on focus, so the row does not
          // shift the rest of the form down by a pixel when it is tapped.
          padding: focused ? "11px 15px" : "12px 16px",
          opacity: disabled ? 0.38 : 1,
          transition: "border-color var(--duration-short) var(--ease-standard)",
        }}
      >
        <span
          style={{ fontSize: 14, color: "var(--color-on-surface-variant)", userSelect: "none" }}
          aria-hidden="true"
        >
          {country.dialCode}
        </span>
        <span
          style={{
            width: 1,
            height: 18,
            margin: "0 12px",
            background: "var(--color-outline-variant)",
          }}
        />
        <input
          // inputMode over type="number": a number spinner on a phone number is
          // meaningless, and type="number" silently drops leading zeros.
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={country.nationalDigits}
          placeholder={"0".repeat(country.nationalDigits)}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // Strip anything that is not a digit as it is typed, so a pasted
          // "+91 98765 43210" becomes usable instead of being rejected. The
          // leading country code is dropped because it is already shown.
          onChange={(e) => {
            let digits = e.target.value.replace(/\D/g, "");
            const bare = country.dialCode.replace("+", "");
            if (digits.length > country.nationalDigits && digits.startsWith(bare)) {
              digits = digits.slice(bare.length);
            }
            onChange(digits.slice(0, country.nationalDigits));
          }}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--font-ui)",
            fontSize: 14,
            letterSpacing: "0.04em",
            color: "var(--color-on-surface)",
          }}
          aria-label={`${label}, ${country.name}, ${country.dialCode}`}
        />
      </div>
    </div>
  );
}

export default MobileField;
