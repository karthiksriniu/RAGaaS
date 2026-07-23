import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, createSessionToken, ADMIN_SESSION_COOKIE } from "@/lib/adminAuth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    const storedHash = process.env.ADMIN_PASSWORD_HASH;

    if (!storedHash) {
      console.error("/api/admin/login: ADMIN_PASSWORD_HASH is not configured");
      return NextResponse.json({ error: "Admin login is not configured" }, { status: 500 });
    }
    if (!password || typeof password !== "string" || !verifyPassword(password, storedHash)) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return res;
  } catch (err) {
    console.error("/api/admin/login POST failed:", err);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
