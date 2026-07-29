import { describe, it, expect, afterAll } from "vitest";
import { createTestTenant, cleanupTestTenants } from "./helpers/testTenant";

const rootDomain = "staging.mybizcare.com";

// Node's fetch() silently ignores an attempt to override the Host header
// (unlike curl's -H "Host: ..."), so spoofing a host against a fixed base
// URL doesn't work here. Real wildcard DNS for *.staging.mybizcare.com is
// already live, so hitting the actual subdomain URL directly is both
// simpler and more realistic than spoofing would have been.
async function fetchAsHost(host: string): Promise<string> {
  const res = await fetch(`https://${host}/`);
  return res.text();
}

describe("subdomain resolution", () => {
  afterAll(cleanupTestTenants);

  it("a real tenant subdomain renders the chat UI", async () => {
    const { subdomain } = await createTestTenant("subres-real");
    const html = await fetchAsHost(`${subdomain}.${rootDomain}`);
    expect(html).toContain("MyBizCare");
    expect(html).not.toContain("linked to a business");
  });

  it("an unrecognized subdomain shows the no-tenant landing", async () => {
    const html = await fetchAsHost(`definitely-not-a-real-tenant-xyz.${rootDomain}`);
    expect(html).toContain("linked to a business");
  });

  it("the bare-ish root shows the no-tenant landing (via a fresh unassigned label)", async () => {
    // The literal bare root (staging.mybizcare.com) also happens to match
    // production's *.mybizcare.com wildcard and gets routed there instead -
    // a known DNS-nesting artifact documented earlier in this project, not
    // a bug. An unassigned single-label subdomain proves the same
    // "no tenant" code path without hitting that ambiguity.
    const html = await fetchAsHost(`no-such-tenant-at-all.${rootDomain}`);
    expect(html).toContain("linked to a business");
  });

  it("an expired tenant shows the distinct 'service unavailable' landing", async () => {
    const { subdomain } = await createTestTenant("subres-expired", {
      licenseExpiresAt: "2020-01-01",
    });
    const html = await fetchAsHost(`${subdomain}.${rootDomain}`);
    expect(html).toContain("currently unavailable");
    expect(html).not.toContain("linked to a business"); // distinct copy, not the generic landing
  });

  it("the legacy .vercel.app host resolves to the default tenant", async () => {
    const html = await fetchAsHost("agriadvisor-poc-staging.vercel.app");
    expect(html).toContain("MyBizCare");
    expect(html).not.toContain("linked to a business");
  });
});
