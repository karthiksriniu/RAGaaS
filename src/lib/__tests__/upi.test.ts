import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  annualSavingPct,
  buildUpiUri,
  canClaim,
  canConfirm,
  isOpenForPayment,
  isPlan,
  licenseKindFor,
  licensePeriodFor,
  newOrderId,
  normalizeUtr,
  priceInrForPlan,
  upiPaymentsEnabled,
  PLAN_PRICE_INR,
  PLAN_PRICE_ANNUAL_INR,
} from "../upi";

// The parts of the payment flow with no database behind them, and every one of
// them is load-bearing: the URI is what actually moves the money, the order id
// is the only handle tying a bank credit back to a business, and the guards are
// what stop one payment being spent twice.

describe("buildUpiUri", () => {
  const base = { vpa: "karthik.sreeni@cub", payeeName: "MyBizCare", amountPaise: 99900, orderId: "MBCAB2CD3EF4" };

  it("carries the payee, a fixed amount in rupees, and the order as the reference", () => {
    const uri = buildUpiUri(base);
    expect(uri.startsWith("upi://pay?")).toBe(true);
    const params = new URLSearchParams(uri.slice("upi://pay?".length));
    expect(params.get("pa")).toBe("karthik.sreeni@cub");
    expect(params.get("pn")).toBe("MyBizCare");
    // Rupees with two decimals - paise anywhere in this field is a 100x error.
    expect(params.get("am")).toBe("999.00");
    expect(params.get("cu")).toBe("INR");
    expect(params.get("tr")).toBe("MBCAB2CD3EF4");
    expect(params.get("tn")).toContain("MBCAB2CD3EF4");
  });

  it("percent-encodes spaces rather than leaving + signs a UPI app would show literally", () => {
    const uri = buildUpiUri({ ...base, payeeName: "My Biz Care" });
    expect(uri).toContain("My%20Biz%20Care");
    expect(uri).not.toContain("+");
  });

  it("leaves the @ in the VPA alone - %40 is legal but not what UPI scanners expect", () => {
    const uri = buildUpiUri(base);
    expect(uri).toContain("pa=karthik.sreeni@cub");
    expect(uri).not.toContain("%40");
  });

  it("keeps a paise-level amount exact", () => {
    expect(buildUpiUri({ ...base, amountPaise: 99950 })).toContain("am=999.50");
  });
});

describe("newOrderId", () => {
  it("is alphanumeric and short enough for the UPI reference field", () => {
    for (let i = 0; i < 50; i++) {
      const id = newOrderId();
      expect(id).toMatch(/^MBC[A-Z0-9]{9}$/);
      expect(id.length).toBeLessThanOrEqual(35);
    }
  });

  it("avoids every glyph pair a human could misread off a bank statement", () => {
    // O/0, I/1, S/5, B/8, Z/2 - one of each pair is gone, so no two characters
    // in a reference can be confused for one another.
    const ids = Array.from({ length: 500 }, () => newOrderId().slice(3)).join("");
    expect(ids).not.toMatch(/[O0I1S5B8Z2]/);
  });

  it("does not collide across a realistic number of signups", () => {
    const ids = new Set(Array.from({ length: 5000 }, newOrderId));
    expect(ids.size).toBe(5000);
  });
});

describe("normalizeUtr", () => {
  it("accepts a 12-digit reference however it was spaced", () => {
    expect(normalizeUtr("5312 4498 7601")).toBe("531244987601");
    expect(normalizeUtr("531244987601")).toBe("531244987601");
  });

  it("returns null rather than throwing for anything else - it is only a hint", () => {
    expect(normalizeUtr("")).toBeNull();
    expect(normalizeUtr("12345")).toBeNull();
    expect(normalizeUtr(undefined)).toBeNull();
    expect(normalizeUtr(1234)).toBeNull();
  });
});

describe("order guards", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it("only a live pending order can be paid against or claimed", () => {
    expect(isOpenForPayment({ status: "pending", qrExpiresAt: future })).toBe(true);
    expect(isOpenForPayment({ status: "pending", qrExpiresAt: past })).toBe(false);
    expect(canClaim({ status: "pending", qrExpiresAt: future })).toBe(true);
  });

  it("a claimed order is closed to further payment, so one order is never paid twice", () => {
    expect(isOpenForPayment({ status: "claimed", qrExpiresAt: future })).toBe(false);
    expect(canClaim({ status: "claimed", qrExpiresAt: future })).toBe(false);
  });

  it("confirmation still applies to an order nobody claimed - they paid and closed the tab", () => {
    expect(canConfirm({ status: "pending", qrExpiresAt: past })).toBe(true);
    expect(canConfirm({ status: "claimed", qrExpiresAt: past })).toBe(true);
  });

  it("a settled order cannot be re-settled, which is what makes the webhook retry-safe", () => {
    expect(canConfirm({ status: "confirmed", qrExpiresAt: future })).toBe(false);
    expect(canConfirm({ status: "rejected", qrExpiresAt: future })).toBe(false);
    expect(canConfirm({ status: "expired", qrExpiresAt: future })).toBe(false);
  });
});

describe("licenseKindFor", () => {
  it("grants three days on the payer's word and a month once the credit is seen", () => {
    expect(licenseKindFor("claimed")).toBe("provisional");
    expect(licenseKindFor("confirmed")).toBe("full");
  });

  it("grants nothing for an order that has not been paid", () => {
    expect(licenseKindFor("pending")).toBeNull();
    expect(licenseKindFor("rejected")).toBeNull();
    expect(licenseKindFor("expired")).toBeNull();
  });
});

describe("upiPaymentsEnabled", () => {
  const VARS = ["UPI_PAYMENTS", "TENANT_ROOT_DOMAIN"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("is off on staging, so signup stays testable without anyone paying", () => {
    process.env.TENANT_ROOT_DOMAIN = "staging.mybizcare.com";
    expect(upiPaymentsEnabled()).toBe(false);
  });

  it("is on in production", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(upiPaymentsEnabled()).toBe(true);
  });

  it("defaults to on when the root domain is unset - a missing env var must not silently give the plan away", () => {
    expect(upiPaymentsEnabled()).toBe(true);
  });

  it("can be forced either way, so the real QR can be exercised on staging", () => {
    process.env.TENANT_ROOT_DOMAIN = "staging.mybizcare.com";
    process.env.UPI_PAYMENTS = "on";
    expect(upiPaymentsEnabled()).toBe(true);
    process.env.UPI_PAYMENTS = "off";
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(upiPaymentsEnabled()).toBe(false);
  });
});

// The plan a payer picks decides both how much is taken and how long the agent
// keeps answering. Both halves are pure, so both are pinned here rather than
// discovered against a live mandate.

describe("plans", () => {
  it("recognises only the two plans that exist", () => {
    expect(isPlan("monthly")).toBe(true);
    expect(isPlan("annual")).toBe(true);
    for (const bad of ["MONTHLY", "yearly", "", null, undefined, 1, {}]) {
      expect(isPlan(bad), String(bad)).toBe(false);
    }
  });

  it("prices each plan, and lets platform_settings override both", () => {
    expect(priceInrForPlan("monthly")).toBe(PLAN_PRICE_INR);
    expect(priceInrForPlan("annual")).toBe(PLAN_PRICE_ANNUAL_INR);
    expect(priceInrForPlan("monthly", 499, 4999)).toBe(499);
    expect(priceInrForPlan("annual", 499, 4999)).toBe(4999);
  });

  // Intervals, not day counts: 31 Jan + 1 month must be 28 Feb, and a year
  // added to 29 Feb must land on 28 Feb, which "+30 days" and "+365 days" both
  // get wrong.
  it("gives Postgres a calendar interval for each plan", () => {
    expect(licensePeriodFor("monthly")).toBe("1 month");
    expect(licensePeriodFor("annual")).toBe("1 year");
  });

  it("computes the annual saving instead of trusting a typed-in number", () => {
    // 999 x 12 = 11,988 against 9,999 - a saving of 1,989.
    expect(annualSavingPct()).toBe(17);
    expect(annualSavingPct(100, 1200)).toBe(0);
    expect(annualSavingPct(100, 600)).toBe(50);
  });

  it("never divides by a zero monthly price", () => {
    expect(annualSavingPct(0, 9999)).toBe(0);
  });
});
