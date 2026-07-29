import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveTenantSlug, isRootDomainHost } from "../tenantHost";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.TENANT_ROOT_DOMAIN;
  delete process.env.LEGACY_DEFAULT_TENANT_HOST;
  delete process.env.DEV_DEFAULT_TENANT_SLUG;
}

describe("resolveTenantSlug", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("returns empty string for the bare apex domain", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(resolveTenantSlug("mybizcare.com")).toBe("");
  });

  it("returns empty string for www", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(resolveTenantSlug("www.mybizcare.com")).toBe("");
  });

  it("returns the label for a single-label subdomain", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(resolveTenantSlug("acme.mybizcare.com")).toBe("acme");
  });

  it("returns empty string for a multi-label subdomain", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(resolveTenantSlug("a.b.mybizcare.com")).toBe("");
  });

  it("returns empty string for a totally unrelated host", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(resolveTenantSlug("example.com")).toBe("");
  });

  it("resolves the legacy host to 'default'", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    process.env.LEGACY_DEFAULT_TENANT_HOST = "agriadvisor-poc.vercel.app";
    expect(resolveTenantSlug("agriadvisor-poc.vercel.app")).toBe("default");
  });

  it("legacy host check takes priority even if it happens to also look like a root-domain match", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    process.env.LEGACY_DEFAULT_TENANT_HOST = "special.mybizcare.com";
    expect(resolveTenantSlug("special.mybizcare.com")).toBe("default");
  });

  it("returns empty string when TENANT_ROOT_DOMAIN is unset entirely", () => {
    expect(resolveTenantSlug("acme.mybizcare.com")).toBe("");
  });

  it("dev fallback: bare localhost resolves to DEV_DEFAULT_TENANT_SLUG outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    process.env.DEV_DEFAULT_TENANT_SLUG = "default";
    expect(resolveTenantSlug("localhost")).toBe("default");
    vi.unstubAllEnvs();
  });

  it("dev fallback: single-label *.localhost resolves to that label outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(resolveTenantSlug("acme.localhost")).toBe("acme");
    vi.unstubAllEnvs();
  });

  it("dev fallback does not apply in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveTenantSlug("localhost")).toBe("");
    vi.unstubAllEnvs();
  });
});

describe("isRootDomainHost", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("is true for the bare apex domain", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(isRootDomainHost("mybizcare.com")).toBe(true);
  });

  it("is true for www", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(isRootDomainHost("www.mybizcare.com")).toBe(true);
  });

  it("is false for a real tenant subdomain, even though resolveTenantSlug and this both treat unknowns as non-root", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(isRootDomainHost("acme.mybizcare.com")).toBe(false);
  });

  it("is false for an unrecognized/typo'd subdomain - that case still gets the generic no-tenant landing page, not the marketing site", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(isRootDomainHost("typo.mybizcare.com")).toBe(false);
  });

  it("is false for a totally unrelated host", () => {
    process.env.TENANT_ROOT_DOMAIN = "mybizcare.com";
    expect(isRootDomainHost("example.com")).toBe(false);
  });

  it("is false when TENANT_ROOT_DOMAIN is unset entirely", () => {
    expect(isRootDomainHost("mybizcare.com")).toBe(false);
  });
});
