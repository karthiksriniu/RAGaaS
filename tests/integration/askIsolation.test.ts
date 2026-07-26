import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { requireEnv } from "./helpers/adminSession";
import { createTestTenant, cleanupTestTenants } from "./helpers/testTenant";

const baseUrl = () => requireEnv("TEST_BASE_URL");

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("/api/ask validation", () => {
  it("rejects a missing tenantId with 400", async () => {
    const res = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown tenant with 403", async () => {
    const res = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test", tenantId: "no-such-tenant-ever" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("/api/ask license enforcement", () => {
  afterAll(cleanupTestTenants);

  it("rejects an expired tenant with 403, distinct from unknown-tenant", async () => {
    const { id } = await createTestTenant("ask-expired", { licenseExpiresAt: "2020-01-01" });
    const res = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "test", tenantId: id }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/expired/i);
  });
});

describe("cross-tenant content isolation (real LLM calls - kept to 2 cases)", () => {
  // Voyage AI's free tier is 3 requests/minute - a short gap before this
  // file's real calls (and between the two sequential ones below) keeps
  // the suite reliable without adding retry/backoff to the app just for
  // test pacing. Same reasoning as ragSmoke.test.ts.
  beforeEach(() => wait(20000));

  it("default and testinsuranceco each only ever cite their own KB", async () => {
    const defaultRes = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Tell me about dragon fruit cultivation",
        tenantId: "default",
      }),
    });
    expect(defaultRes.status).toBe(200);
    const defaultBody = await defaultRes.json();
    for (const citation of defaultBody.citations || []) {
      expect(citation.source_uri).not.toContain("exotic_fruits");
    }

    await wait(20000);
    const otherRes = await fetch(`${baseUrl()}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What should I do about early blight on tomato?",
        tenantId: "testinsuranceco",
      }),
    });
    expect(otherRes.status).toBe(200);
    const otherBody = await otherRes.json();
    for (const citation of otherBody.citations || []) {
      expect(citation.source_uri).not.toContain("agronomy_kb");
    }
  });
});
