import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";
import {
  cashfreeConfig,
  cashfreeConfigured,
  cashfreeEnv,
  looksLikeTestAppId,
  verifyWebhookSignature,
  CashfreeNotConfiguredError,
  cashfreeApiVersion,
  CASHFREE_API_VERSION_DEFAULT,
  planKind,
  planToPaise,
  onePeriodAfter,
  toCashfreePhone,
} from "../cashfree";

// A webhook is the only thing standing between "Cashfree says this was paid"
// and a month of licence granted to a tenant. Every test here is about one of
// the two ways that goes wrong: accepting something Cashfree did not send, or
// rejecting something it did.

const SECRET = "cfsk_ma_test_0000000000000000_abcdef";

function sign(timestamp: string, rawBody: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
}

describe("verifyWebhookSignature", () => {
  const now = new Date("2026-09-04T10:00:00Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  // Deliberately not canonical: Cashfree sends what it sends, spacing included,
  // and the point of these tests is that we verify those exact bytes.
  const rawBody =
    '{"type": "SUBSCRIPTION_PAYMENT_SUCCESS", "data": {"subscription_id": "sub_1", "amount": 999}}';

  it("accepts a genuine signature", () => {
    const verdict = verifyWebhookSignature({
      timestamp,
      rawBody,
      signature: sign(timestamp, rawBody),
      secretKey: SECRET,
      now,
    });
    expect(verdict).toEqual({ ok: true });
  });

  // The whole reason the route must read req.text() before req.json(). A body
  // that has been parsed and re-serialised is a DIFFERENT string - key order
  // and whitespace both survive the wire - so verifying against it would reject
  // every real webhook Cashfree ever sends.
  it("rejects a re-serialised body that means the same thing", () => {
    const signature = sign(timestamp, rawBody);
    const roundTripped = JSON.stringify(JSON.parse(rawBody));
    const spacedOut = JSON.stringify(JSON.parse(rawBody), null, 2);

    expect(roundTripped).not.toBe(rawBody); // guards the premise of this test
    for (const body of [roundTripped, spacedOut]) {
      expect(
        verifyWebhookSignature({ timestamp, rawBody: body, signature, secretKey: SECRET, now })
      ).toEqual({ ok: false, reason: "mismatch" });
    }
  });

  it("rejects a tampered amount", () => {
    const signature = sign(timestamp, rawBody);
    const tampered = rawBody.replace('"amount": 999', '"amount": 1');
    expect(
      verifyWebhookSignature({ timestamp, rawBody: tampered, signature, secretKey: SECRET, now })
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyWebhookSignature({
        timestamp,
        rawBody,
        signature: sign(timestamp, rawBody, "someone-elses-secret"),
        secretKey: SECRET,
        now,
      })
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a timestamp that has been swapped for another", () => {
    const signature = sign(timestamp, rawBody);
    const other = String(Number(timestamp) - 60);
    expect(
      verifyWebhookSignature({ timestamp: other, rawBody, signature, secretKey: SECRET, now })
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  // A captured, correctly-signed request must not stay valid forever.
  it("rejects a replay from outside the age window", () => {
    const old = String(Math.floor(now.getTime() / 1000) - 301);
    expect(
      verifyWebhookSignature({
        timestamp: old,
        rawBody,
        signature: sign(old, rawBody),
        secretKey: SECRET,
        now,
      })
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts one just inside the age window", () => {
    const recent = String(Math.floor(now.getTime() / 1000) - 299);
    expect(
      verifyWebhookSignature({
        timestamp: recent,
        rawBody,
        signature: sign(recent, rawBody),
        secretKey: SECRET,
        now,
      })
    ).toEqual({ ok: true });
  });

  // A clock skewed the other way is just as much a forgery signal.
  it("rejects a timestamp far in the future", () => {
    const ahead = String(Math.floor(now.getTime() / 1000) + 3600);
    expect(
      verifyWebhookSignature({
        timestamp: ahead,
        rawBody,
        signature: sign(ahead, rawBody),
        secretKey: SECRET,
        now,
      })
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a timestamp it cannot read rather than skipping the age check", () => {
    expect(
      verifyWebhookSignature({
        timestamp: "not-a-number",
        rawBody,
        signature: sign("not-a-number", rawBody),
        secretKey: SECRET,
        now,
      })
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("reports missing headers as missing, not as a mismatch", () => {
    const base = { rawBody, secretKey: SECRET, now };
    expect(verifyWebhookSignature({ ...base, timestamp: "", signature: "x" }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, timestamp, signature: "" })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      verifyWebhookSignature({ ...base, timestamp, signature: "x", secretKey: "" })
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("can have the age check switched off entirely", () => {
    const ancient = "1000000000";
    expect(
      verifyWebhookSignature({
        timestamp: ancient,
        rawBody,
        signature: sign(ancient, rawBody),
        secretKey: SECRET,
        now,
        maxAgeSeconds: 0,
      })
    ).toEqual({ ok: true });
  });
});

describe("credentials", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.CASHFREE_APP_ID;
    delete process.env.CASHFREE_SECRET_KEY;
    delete process.env.CASHFREE_ENV;
    delete process.env.CASHFREE_API_VERSION;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("defaults to sandbox, never to production", () => {
    expect(cashfreeEnv()).toBe("sandbox");
    process.env.CASHFREE_ENV = "staging"; // not a value this understands
    expect(cashfreeEnv()).toBe("sandbox");
    process.env.CASHFREE_ENV = "production";
    expect(cashfreeEnv()).toBe("production");
  });

  it("knows a sandbox key by its prefix", () => {
    expect(looksLikeTestAppId("TEST112067046132b7f382d135f058d540760211")).toBe(true);
    expect(looksLikeTestAppId("  test1234  ")).toBe(true);
    expect(looksLikeTestAppId("1392546ddd15d25c8641b2526076452931")).toBe(false);
  });

  it("reports whether it is configured without throwing", () => {
    expect(cashfreeConfigured()).toBe(false);
    process.env.CASHFREE_APP_ID = "TEST1";
    expect(cashfreeConfigured()).toBe(false);
    process.env.CASHFREE_SECRET_KEY = "s";
    expect(cashfreeConfigured()).toBe(true);
  });

  it("names the variable that is missing", () => {
    expect(() => cashfreeConfig()).toThrow(CashfreeNotConfiguredError);
    expect(() => cashfreeConfig()).toThrow(/CASHFREE_APP_ID/);
    process.env.CASHFREE_APP_ID = "TEST1";
    expect(() => cashfreeConfig()).toThrow(/CASHFREE_SECRET_KEY/);
  });

  it("points sandbox at the sandbox host", () => {
    process.env.CASHFREE_APP_ID = "TEST112067046132b7f382d135f058d540760211";
    process.env.CASHFREE_SECRET_KEY = SECRET;
    const config = cashfreeConfig();
    expect(config.env).toBe("sandbox");
    expect(config.baseUrl).toBe("https://sandbox.cashfree.com/pg");
    expect(config.appId).toBe("TEST112067046132b7f382d135f058d540760211");
  });

  // The failure this prevents is silent: a live deployment on the TEST pair
  // authorises every mandate against a sandbox that forgets them, and collects
  // nothing, while reporting success to every payer.
  it("refuses to run production on a sandbox key", () => {
    process.env.CASHFREE_ENV = "production";
    process.env.CASHFREE_APP_ID = "TEST112067046132b7f382d135f058d540760211";
    process.env.CASHFREE_SECRET_KEY = SECRET;
    expect(() => cashfreeConfig()).toThrow(/no payment would ever be collected/);
  });

  it("warns, but proceeds, when sandbox is given a live-looking key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CASHFREE_APP_ID = "1392546ddd15d25c8641b2526076452931";
    process.env.CASHFREE_SECRET_KEY = SECRET;
    expect(cashfreeConfig().env).toBe("sandbox");
    expect(warn).toHaveBeenCalled();
  });

  // Cashfree's own docs disagree about this - orders says 2025-01-01,
  // subscriptions says 2026-01-01 - and a wrong version does not fail loudly,
  // it changes field names. So it must be flippable from Vercel.
  it("pins an API version but lets the environment override it", () => {
    expect(cashfreeApiVersion()).toBe(CASHFREE_API_VERSION_DEFAULT);
    process.env.CASHFREE_API_VERSION = "2026-01-01";
    expect(cashfreeApiVersion()).toBe("2026-01-01");
    process.env.CASHFREE_API_VERSION = "   ";
    expect(cashfreeApiVersion()).toBe(CASHFREE_API_VERSION_DEFAULT);
  });
});


// Which plan is which decides what a customer is charged under which heading.
// It is read off plan_interval_type and nothing else - a plan's NAME is free
// text somebody typed into a dashboard, and the two names supplied for these
// very plans arrived transposed.
describe("planKind", () => {
  it("identifies plans by their interval, not their name", () => {
    expect(planKind({ plan_id: "p", plan_name: "MyBizCare Annual", plan_interval_type: "MONTH" }))
      .toBe("monthly");
    expect(planKind({ plan_id: "p", plan_name: "MyBizCare Monthly", plan_interval_type: "YEAR" }))
      .toBe("annual");
  });

  it("honours plan_intervals, so a 3-month plan is neither of ours", () => {
    expect(planKind({ plan_id: "p", plan_interval_type: "MONTH", plan_intervals: 1 })).toBe("monthly");
    expect(planKind({ plan_id: "p", plan_interval_type: "MONTH", plan_intervals: 3 })).toBeNull();
    expect(planKind({ plan_id: "p", plan_interval_type: "YEAR", plan_intervals: 2 })).toBeNull();
  });

  it("refuses to guess at intervals we do not sell", () => {
    expect(planKind({ plan_id: "p", plan_interval_type: "DAY" })).toBeNull();
    expect(planKind({ plan_id: "p", plan_interval_type: "WEEK" })).toBeNull();
    expect(planKind({ plan_id: "p" })).toBeNull();
  });
});

describe("planToPaise", () => {
  it("converts Cashfree's rupees to our paise", () => {
    expect(planToPaise({ plan_id: "p", plan_amount: 999 })).toBe(99900);
    expect(planToPaise({ plan_id: "p", plan_amount: 9999 })).toBe(999900);
  });

  it("rounds rather than truncates a float round-trip", () => {
    expect(planToPaise({ plan_id: "p", plan_amount: 998.9999 })).toBe(99900);
    expect(planToPaise({ plan_id: "p", plan_amount: 999.005 })).toBe(99901);
  });

  it("returns null rather than 0 when there is no amount to convert", () => {
    expect(planToPaise({ plan_id: "p" })).toBeNull();
    expect(planToPaise({ plan_id: "p", plan_amount: NaN })).toBeNull();
  });
});


// If the authorisation collects cycle one, the first PERIODIC charge must be a
// full period out. Scheduled "now" it bills the customer twice in their first
// week, and this is the arithmetic that stops it.
describe("onePeriodAfter", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it("adds a calendar month, not thirty days", () => {
    expect(iso(onePeriodAfter(new Date("2026-01-15T10:00:00Z"), "monthly"))).toBe("2026-02-15");
    expect(iso(onePeriodAfter(new Date("2026-03-01T10:00:00Z"), "monthly"))).toBe("2026-04-01");
  });

  // 31 Jan + 1 month must not roll into March.
  it("clamps to the last day when the next month is shorter", () => {
    expect(iso(onePeriodAfter(new Date("2026-01-31T10:00:00Z"), "monthly"))).toBe("2026-02-28");
    expect(iso(onePeriodAfter(new Date("2026-05-31T10:00:00Z"), "monthly"))).toBe("2026-06-30");
  });

  it("adds a calendar year", () => {
    expect(iso(onePeriodAfter(new Date("2026-09-05T10:00:00Z"), "annual"))).toBe("2027-09-05");
  });

  // 29 Feb + a year has no counterpart; it must land on 28 Feb, not 1 March.
  it("handles a leap day", () => {
    expect(iso(onePeriodAfter(new Date("2028-02-29T10:00:00Z"), "annual"))).toBe("2029-02-28");
  });

  it("does not mutate the date it was given", () => {
    const from = new Date("2026-01-15T10:00:00Z");
    onePeriodAfter(from, "annual");
    expect(iso(from)).toBe("2026-01-15");
  });
});

describe("toCashfreePhone", () => {
  it("reduces our E.164 numbers to the bare ten digits", () => {
    expect(toCashfreePhone("+919840816035")).toBe("9840816035");
    expect(toCashfreePhone("919840816035")).toBe("9840816035");
    expect(toCashfreePhone("9840816035")).toBe("9840816035");
    expect(toCashfreePhone("+91 98408 16035")).toBe("9840816035");
  });

  it("leaves a short or empty value alone rather than inventing digits", () => {
    expect(toCashfreePhone("98408")).toBe("98408");
    expect(toCashfreePhone("")).toBe("");
  });
});
