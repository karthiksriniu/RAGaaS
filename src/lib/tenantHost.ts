/** Parses the Host header into a tenant subdomain slug, or "" for "no
 * tenant" (bare apex/www, an unrecognized host, or a multi-label subdomain -
 * only single-label subdomains are supported). No DB lookup here - this
 * only produces a slug string; whether it's a real, licensed tenant is
 * checked downstream in page.tsx. */
export function resolveTenantSlug(host: string): string {
  const rootDomain = process.env.TENANT_ROOT_DOMAIN;
  const legacyHost = process.env.LEGACY_DEFAULT_TENANT_HOST;

  if (legacyHost && host === legacyHost) return "default";

  if (rootDomain) {
    if (host === rootDomain || host === `www.${rootDomain}`) return "";
    if (host.endsWith(`.${rootDomain}`)) {
      const label = host.slice(0, -(rootDomain.length + 1));
      return label.includes(".") ? "" : label;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    const devDefault = process.env.DEV_DEFAULT_TENANT_SLUG || "";
    if (host === "localhost") return devDefault;
    if (host.endsWith(".localhost")) {
      const label = host.slice(0, -".localhost".length);
      return label.includes(".") ? "" : label;
    }
  }

  return "";
}

/** True only for the bare apex or www of TENANT_ROOT_DOMAIN - distinct from
 * resolveTenantSlug()'s "" result, which also covers unrecognized/typo'd
 * subdomains and unrelated hosts. Used to show the public marketing site at
 * the root domain instead of the generic "not linked to a business" landing
 * page, without changing resolveTenantSlug's existing tenant-resolution
 * contract (still "" for both cases, unit-tested above). */
export function isRootDomainHost(host: string): boolean {
  const rootDomain = process.env.TENANT_ROOT_DOMAIN;
  if (!rootDomain) return false;
  return host === rootDomain || host === `www.${rootDomain}`;
}

/** The public web-chat URL for a tenant, or null where this deployment has no
 * root domain configured.
 *
 * Built here rather than in the browser because only the server knows
 * TENANT_ROOT_DOMAIN, and it genuinely differs per environment - production
 * hangs tenants off mybizcare.com while staging hangs them off
 * staging.mybizcare.com. A client guessing from window.location would get
 * staging right by accident and production wrong the moment the dashboard is
 * ever served from a host that is not the tenant root. */
export function tenantChatUrl(subdomain: string): string | null {
  const rootDomain = process.env.TENANT_ROOT_DOMAIN;
  if (!rootDomain || !subdomain) return null;
  return `https://${subdomain}.${rootDomain}`;
}
