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
  /** Digit dialled before a national number domestically - "0" in India. Not
   * part of the number itself, and never valid at the front of a real one. */
  trunkPrefix?: string;
}

export const COUNTRIES: Country[] = [
  { dialCode: "+91", name: "India", nationalDigits: 10, trunkPrefix: "0" },
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

/** Reduces anything a person might type or paste to the national digits.
 *
 * Peels prefixes in a loop rather than once, because they combine: "0" then
 * "91" is a perfectly normal way to write a number down. Only peels while the
 * value is still too long, so a legitimate ten-digit number starting with a
 * prefix digit is never eaten.
 *
 * Extracted and exported so it can be tested directly. The version that lived
 * inline handled a pasted "+91 98765 43210" but silently truncated the very
 * common "09840816035" to "0984081603" - a different number, and one the user
 * was then told was invalid without being told why.
 */
export function toNationalDigits(raw: string, country: Country = DEFAULT_COUNTRY): string {
  let digits = (raw || "").replace(/\D/g, "");
  const international = country.dialCode.replace("+", "");

  for (let i = 0; i < 3; i++) {
    if (digits.length <= country.nationalDigits) break;
    if (digits.startsWith(international)) {
      digits = digits.slice(international.length);
    } else if (country.trunkPrefix && digits.startsWith(country.trunkPrefix)) {
      digits = digits.slice(country.trunkPrefix.length);
    } else {
      break;
    }
  }
  return digits.slice(0, country.nationalDigits);
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
          // Normalised as it is typed, so a pasted "+91 98765 43210" or a
          // dictated "09840816035" becomes usable instead of being rejected.
          onChange={(e) => onChange(toNationalDigits(e.target.value, country))}
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
