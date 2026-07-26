import { describe, it, expect, afterAll } from "vitest";
import { requireEnv } from "./helpers/adminSession";
import { createTestTenant, cleanupTestTenants } from "./helpers/testTenant";

const baseUrl = () => requireEnv("TEST_BASE_URL");
const runRealCallTests = process.env.RUN_REAL_CALL_TESTS === "1";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postEscalate(body: Record<string, unknown>) {
  return fetch(`${baseUrl()}/api/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/escalate validation", () => {
  afterAll(cleanupTestTenants);

  it("rejects an invalid phone number format with 400", async () => {
    const res = await postEscalate({ question: "test", farmerPhone: "not-a-phone", tenantId: "default" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing tenantId with 400", async () => {
    const res = await postEscalate({ question: "test", farmerPhone: "+919840000000" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown tenant with 403", async () => {
    const res = await postEscalate({
      question: "test",
      farmerPhone: "+919840000000",
      tenantId: "no-such-tenant-ever",
    });
    expect(res.status).toBe(403);
  });

  it("rejects an expired tenant with 403", async () => {
    const { id } = await createTestTenant("escalate-expired", { licenseExpiresAt: "2020-01-01" });
    const res = await postEscalate({ question: "test", farmerPhone: "+919840000000", tenantId: id });
    expect(res.status).toBe(403);
  });
});

// Rate limiting is tested against the real deployed /api/escalate, since
// this endpoint places a real, billed Twilio call to an arbitrary
// caller-supplied number - the concrete concern isn't just abuse volume,
// it's repeated calls to one victim's phone. Both caps share one
// per-IP bucket (this test runner's IP), so each test below waits out the
// 60s window first to start from a clean count - otherwise leftover
// requests from earlier tests in this file would non-deterministically
// shift where the boundary falls.
describe("/api/escalate rate limiting (real requests, no real calls placed - blocked before Twilio)", () => {
  it("blocks the 4th request within an hour to the same phone number with 429", async () => {
    await wait(61000);
    const phone = "+919840000099"; // dedicated to this test, never reused elsewhere
    const responses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await postEscalate({ question: "test", farmerPhone: phone, tenantId: "no-such-tenant-ever" });
      responses.push(res.status);
    }
    // First 3 pass rate limiting and reach the (nonexistent) tenant check;
    // the 4th is blocked by the per-phone cap before that check runs.
    expect(responses).toEqual([403, 403, 403, 429]);
  }, 90000);

  it("blocks the 6th request within a minute from the same IP with 429", async () => {
    await wait(61000);
    // A distinct phone number per request keeps each one under its own
    // per-phone cap (3/hour), so only the shared per-IP bucket (5/min) can
    // be the thing that blocks the 6th request here.
    const responses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await postEscalate({
        question: "test",
        farmerPhone: `+91984000010${i}`,
        tenantId: "no-such-tenant-ever",
      });
      responses.push(res.status);
    }
    expect(responses).toEqual([403, 403, 403, 403, 403, 429]);
  }, 90000);
});

// Places a real Twilio voice call to TEST_FARMER_PHONE - opt-in only, so
// routine `npm test` runs (including the ones after each security fix)
// never dial a real phone unless explicitly asked to via
// `npm run test:integration:calls`.
describe.skipIf(!runRealCallTests)("/api/escalate happy path (real call, opt-in)", () => {
  it("places a real call for a valid request and returns 200", async () => {
    const res = await postEscalate({
      question: "integration test escalation",
      farmerPhone: requireEnv("TEST_FARMER_PHONE"),
      tenantId: "default",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.farmerCallSid).toBeTruthy();
    expect(body.expertCallSid).toBeTruthy();
  });
});
