import { describe, it, expect } from "vitest";
import { requireEnv } from "./helpers/adminSession";

const baseUrl = () => requireEnv("TEST_BASE_URL");

describe("admin auth", () => {
  it("rejects a wrong password with 401", async () => {
    const res = await fetch(`${baseUrl()}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "definitely-wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct password and sets a session cookie", async () => {
    const res = await fetch(`${baseUrl()}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: requireEnv("TEST_ADMIN_PASSWORD") }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("agriadvisor_admin_session");
  });

  it("rejects /api/admin/ingest without a session", async () => {
    const res = await fetch(`${baseUrl()}/api/admin/ingest?tenantId=default`);
    expect(res.status).toBe(401);
  });

  it("allows /api/admin/ingest with a valid session", async () => {
    const login = await fetch(`${baseUrl()}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: requireEnv("TEST_ADMIN_PASSWORD") }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const res = await fetch(`${baseUrl()}/api/admin/ingest?tenantId=default`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sources)).toBe(true);
  });

  it("logout clears the session cookie", async () => {
    // Sessions are stateless HMAC-signed tokens with no server-side
    // revocation list (verifySessionToken only checks signature + expiry) -
    // logout can only tell the browser to drop the cookie, it can't
    // invalidate a copy of the token that's already been extracted. So the
    // real, honest guarantee to test is "the response clears the cookie",
    // not "the old token stops working if resent" - it still would.
    const login = await fetch(`${baseUrl()}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: requireEnv("TEST_ADMIN_PASSWORD") }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const logout = await fetch(`${baseUrl()}/api/admin/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logout.status).toBe(200);
    const clearedCookie = logout.headers.get("set-cookie") || "";
    expect(clearedCookie).toContain("agriadvisor_admin_session=;");
  });

  it("the old public /api/ingest path no longer exists", async () => {
    const res = await fetch(`${baseUrl()}/api/ingest`);
    expect(res.status).toBe(404);
  });

  it("farmer-facing routes stay reachable without any session", async () => {
    const home = await fetch(`${baseUrl()}/`);
    expect(home.status).toBe(200);

    const webhook = await fetch(`${baseUrl()}/api/whatsapp/webhook`, {
      method: "POST",
      body: "unsigned=1",
    });
    // Rejected for an invalid signature, not for lacking an admin session -
    // proves the admin gate doesn't over-scope onto Twilio's webhook.
    expect(webhook.status).toBe(403);
  });
});
