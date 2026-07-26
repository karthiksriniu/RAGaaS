import { describe, it, expect, afterAll } from "vitest";
import { requireEnv, getAdminSessionCookie } from "./helpers/adminSession";
import { createTestTenant, uniqueTestTenantId, cleanupTestTenants } from "./helpers/testTenant";

const baseUrl = () => requireEnv("TEST_BASE_URL");

describe("tenant CRUD", () => {
  afterAll(cleanupTestTenants);

  it("creates a tenant and its subdomain is immediately live, no extra step", async () => {
    const { subdomain } = await createTestTenant("crud-basic");
    // Real wildcard DNS for *.staging.mybizcare.com is live, so hit the
    // actual subdomain URL directly - fetch() silently ignores attempts to
    // override the Host header against a fixed base URL.
    const chatRes = await fetch(`https://${subdomain}.staging.mybizcare.com/`);
    expect(chatRes.status).toBe(200);
    const html = await chatRes.text();
    expect(html).toContain("MyBizCare"); // chat UI rendered, not the no-tenant landing
    expect(html).not.toContain("linked to a business"); // the NoTenantLanding copy
  });

  it("rejects a duplicate subdomain with 409", async () => {
    const cookie = await getAdminSessionCookie();
    const id = uniqueTestTenantId("dup");
    await createTestTenant("dup-source", { name: "First" });

    // Try to create a second tenant reusing the SAME subdomain as the one
    // just created above by re-deriving it - simpler: create one, then
    // attempt the exact same subdomain again directly.
    const first = await fetch(`${baseUrl()}/api/admin/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Dup A", subdomain: id }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl()}/api/admin/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Dup B", subdomain: id }),
    });
    expect(second.status).toBe(409);
  });

  it("rejects reserved subdomains", async () => {
    const cookie = await getAdminSessionCookie();
    for (const reserved of ["www", "admin", "api", "staging"]) {
      const res = await fetch(`${baseUrl()}/api/admin/tenants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Reserved Test", subdomain: reserved }),
      });
      expect(res.status, `subdomain "${reserved}" should be rejected`).toBe(400);
    }
  });

  it("rejects an invalid WhatsApp number format", async () => {
    const cookie = await getAdminSessionCookie();
    const res = await fetch(`${baseUrl()}/api/admin/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Bad Number",
        subdomain: uniqueTestTenantId("badnum"),
        whatsappNumber: "not-a-phone-number",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate WhatsApp number with 409", async () => {
    const cookie = await getAdminSessionCookie();
    const sharedNumber = `+1555${Date.now().toString().slice(-7)}`;

    const first = await fetch(`${baseUrl()}/api/admin/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Number A",
        subdomain: uniqueTestTenantId("num-a"),
        whatsappNumber: sharedNumber,
      }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl()}/api/admin/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "Number B",
        subdomain: uniqueTestTenantId("num-b"),
        whatsappNumber: sharedNumber,
      }),
    });
    expect(second.status).toBe(409);
  });

  it("PATCHes license expiry and WhatsApp number independently", async () => {
    const { id, cookie } = await createTestTenant("patch");

    const licenseRes = await fetch(`${baseUrl()}/api/admin/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ licenseExpiresAt: "2020-01-01" }),
    });
    expect(licenseRes.status).toBe(200);
    const licenseBody = await licenseRes.json();
    expect(licenseBody.tenant.licenseExpiresAt).toBeTruthy();
    expect(licenseBody.tenant.twilioWhatsappNumber).toBeNull(); // unaffected by the license-only patch

    const numberRes = await fetch(`${baseUrl()}/api/admin/tenants/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ whatsappNumber: "+15559998888" }),
    });
    expect(numberRes.status).toBe(200);
    const numberBody = await numberRes.json();
    expect(numberBody.tenant.twilioWhatsappNumber).toBe("whatsapp:+15559998888");
    expect(numberBody.tenant.licenseExpiresAt).toBeTruthy(); // unaffected by the number-only patch
  });

  it("tenant list includes rootDomain", async () => {
    const cookie = await getAdminSessionCookie();
    const res = await fetch(`${baseUrl()}/api/admin/tenants`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rootDomain).toBe("staging.mybizcare.com");
    expect(Array.isArray(body.tenants)).toBe(true);
  });
});
