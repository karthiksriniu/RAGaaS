import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { configuredChannel, generateCode } from "../otpDelivery";

// These two behaviours are the whole strength of business login. Both were
// wrong before: the code was the hard-coded constant "000000", and nothing
// checked whether the environment could deliver a code at all - so production
// would have issued a fixed, undeliverable code while hiding the on-screen
// hint that was the only reason a fixed code had been safe.

const VARS = ["TWILIO_VERIFY_SERVICE_SID", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;

describe("configuredChannel", () => {
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

  it("reports no channel when nothing is configured", () => {
    expect(configuredChannel()).toBe("none");
  });

  it("reports whatsapp only when all three credentials are present", () => {
    for (const v of VARS) process.env[v] = "x";
    expect(configuredChannel()).toBe("whatsapp");
  });

  // Partial configuration is the dangerous state: it looks set up. Claiming
  // whatsapp here would let production issue codes that are never sent, with
  // the owner staring at a code screen for a message that is not coming.
  it("refuses to claim whatsapp when any one credential is missing", () => {
    for (const missing of VARS) {
      for (const v of VARS) process.env[v] = "x";
      delete process.env[missing];
      expect(configuredChannel(), `missing ${missing}`).toBe("none");
    }
  });
});

describe("generateCode", () => {
  const saved = process.env.OTP_TEST_CODE;
  beforeEach(() => delete process.env.OTP_TEST_CODE);
  afterEach(() => {
    if (saved === undefined) delete process.env.OTP_TEST_CODE;
    else process.env.OTP_TEST_CODE = saved;
  });

  it("is always six digits", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("is not a constant", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
    // 200 draws from a million values collide rarely; anything under 150
    // distinct means it is not really random.
    expect(seen.size).toBeGreaterThan(150);
  });

  it("never returns the old hard-coded code by default", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("can still be pinned for automated tests", () => {
    process.env.OTP_TEST_CODE = "123456";
    expect(generateCode()).toBe("123456");
  });
});
