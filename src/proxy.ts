import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { resolveTenantSlug, isRootDomainHost } from "@/lib/tenantHost";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

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
  // Threaded through the same way as x-tenant-slug rather than having
  // page.tsx re-read the Host header itself via next/headers() - proxy.ts's
  // request.headers is the one place this Host value is reliably correct.
  requestHeaders.set("x-is-root-domain", String(isRootDomainHost(host)));
  return NextResponse.next({ request: { headers: requestHeaders } });
}
