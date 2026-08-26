import { describe, it, expect } from "vitest";
import { toNationalDigits, toE164, DEFAULT_COUNTRY } from "../../components/MobileField";

// People write Indian mobile numbers half a dozen ways and all of them are
// "correct" to the person typing. Getting this wrong is not a validation
// message - a silently truncated number is a DIFFERENT number, and for a
// product that phones you with a login code, that is a call to a stranger.

describe("toNationalDigits", () => {
  const cases: [string, string][] = [
    ["9840816035", "9840816035"],
    ["+919840816035", "9840816035"],
    ["+91 98408 16035", "9840816035"],
    ["919840816035", "9840816035"],
    ["09840816035", "9840816035"],      // domestic trunk prefix
    ["0919840816035", "9840816035"],    // trunk AND country code together
    ["00919840816035", "9840816035"],   // international access code
    ["98408-16035", "9840816035"],
    ["9840816035abc", "9840816035"],
    ["  9840816035  ", "9840816035"],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => {
      expect(toNationalDigits(input)).toBe(expected);
    });
  }

  // The peeling must only happen while the value is too long, or a real number
  // that happens to start with a prefix digit would lose its first digit.
  it("never eats a digit from an already-correct number", () => {
    for (const n of ["9184081603", "9111111111", "6000000000", "9999999999"]) {
      expect(toNationalDigits(n), n).toBe(n);
    }
  });

  it("does not invent digits from a partial entry", () => {
    expect(toNationalDigits("98408")).toBe("98408");
    expect(toNationalDigits("")).toBe("");
  });

  it("never returns more than the national length", () => {
    expect(toNationalDigits("12345678901234567890").length).toBe(DEFAULT_COUNTRY.nationalDigits);
  });
});

describe("toE164", () => {
  it("prefixes the dial code", () => {
    expect(toE164("9840816035")).toBe("+919840816035");
  });
});
