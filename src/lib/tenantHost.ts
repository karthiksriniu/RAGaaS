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
