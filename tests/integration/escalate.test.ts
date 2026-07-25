import { describe, it, expect, afterAll } from "vitest";
import { requireEnv } from "./helpers/adminSession";
import { createTestTenant, cleanupTestTenants } from "./helpers/testTenant";

const baseUrl = () => requireEnv("TEST_BASE_URL");
const runRealCallTests = process.env.RUN_REAL_CALL_TESTS === "1";

describe("/api/escalate validation", () => {
  afterAll(cleanupTestTenants);

  it("rejects an invalid phone number format with 400", async () => {
    const res = await fetch(`${baseUrl()}/api/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test", farmerPhone: "not-a-phone", tenantId: "default" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing tenantId with 400", async () => {
    const res = await fetch(`${baseUrl()}/api/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test", farmerPhone: "+919840000000" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown tenant with 403", async () => {
    const res = await fetch(`${baseUrl()}/api/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "test",
        farmerPhone: "+919840000000",
        tenantId: "no-such-tenant-ever",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an expired tenant with 403", async () => {
    const { id } = await createTestTenant("escalate-expired", { licenseExpiresAt: "2020-01-01" });
    const res = await fetch(`${baseUrl()}/api/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test", farmerPhone: "+919840000000", tenantId: id }),
    });
    expect(res.status).toBe(403);
  });
});

// Places a real Twilio voice call to TEST_FARMER_PHONE - opt-in only, so
// routine `npm test` runs (including the ones after each security fix)
// never dial a real phone unless explicitly asked to via
// `npm run test:integration:calls`.
describe.skipIf(!runRealCallTests)("/api/escalate happy path (real call, opt-in)", () => {
  it("places a real call for a valid request and returns 200", async () => {
    const res = await fetch(`${baseUrl()}/api/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "integration test escalation",
        farmerPhone: requireEnv("TEST_FARMER_PHONE"),
        tenantId: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.farmerCallSid).toBeTruthy();
    expect(body.expertCallSid).toBeTruthy();
  });
});
