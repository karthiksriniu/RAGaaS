import { NextResponse } from "next/server";
import { BUSINESS_SESSION_COOKIE } from "@/lib/businessAuth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(BUSINESS_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
