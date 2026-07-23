import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";

// Scoped only to the admin surface - the farmer-facing site (/), Twilio's
// webhooks (/api/whatsapp/*, /api/voice/*), /api/ask, and /api/escalate must
// stay reachable without a session, so they're deliberately excluded here.
export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
