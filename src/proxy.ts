import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

/** Parses the Host header into a tenant subdomain slug, or "" for "no
 * tenant" (bare apex/www, an unrecognized host, or a multi-label subdomain -
 * Phase 2 only supports single-label subdomains). No DB lookup here - this
 * only produces a slug string; whether it's a real, licensed tenant is
 * checked downstream in page.tsx. */
function resolveTenantSlug(host: string): string {
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

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Admin surface - Phase 1 logic, unchanged.
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    if (pathname === "/admin/login" || pathname === "/api/admin/login") {
      return NextResponse.next();
    }
    if (isAdminSession(request)) {
      return NextResponse.next();
    }
    if (pathname.startsWith("/api/admin/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/admin/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Everything else - resolve which tenant this hostname belongs to.
  const host = (request.headers.get("host") || "").split(":")[0];
  const tenantSlug = resolveTenantSlug(host);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-tenant-slug", tenantSlug);
  return NextResponse.next({ request: { headers: requestHeaders } });
}
