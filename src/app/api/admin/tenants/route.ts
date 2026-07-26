import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { listTenants, createTenant } from "@/lib/tenants";

export const runtime = "nodejs";

// staging is reserved specifically because a production tenant subdomain of
// "staging" would collide with staging.mybizcare.com, the staging
// environment's own wildcard.
const RESERVED_SUBDOMAINS = new Set(["www", "admin", "api", "staging"]);
const SUBDOMAIN_PATTERN = /^[a-z0-9-]{1,63}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function GET(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tenants = await listTenants();
  return NextResponse.json({ tenants, rootDomain: process.env.TENANT_ROOT_DOMAIN || null });
}

export async function POST(req: NextRequest) {
  if (!isAdminSession(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { name, subdomain, licenseExpiresAt, whatsappNumber, twilioAccountSid, twilioAuthToken } = await req.json();

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!subdomain || typeof subdomain !== "string") {
      return NextResponse.json({ error: "subdomain is required" }, { status: 400 });
    }

    const slug = slugify(subdomain);
    if (!SUBDOMAIN_PATTERN.test(slug)) {
      return NextResponse.json(
        { error: "subdomain must be 1-63 characters, letters/numbers/hyphens only" },
        { status: 400 }
      );
    }
    if (RESERVED_SUBDOMAINS.has(slug)) {
      return NextResponse.json({ error: `"${slug}" is a reserved subdomain` }, { status: 400 });
    }
    if (
      licenseExpiresAt !== null &&
      licenseExpiresAt !== undefined &&
      isNaN(Date.parse(licenseExpiresAt))
    ) {
      return NextResponse.json({ error: "licenseExpiresAt must be a valid date" }, { status: 400 });
    }
    if (whatsappNumber && (typeof whatsappNumber !== "string" || !E164.test(whatsappNumber.trim()))) {
      return NextResponse.json(
        { error: "whatsappNumber must be in international format, e.g. +14155238886" },
        { status: 400 }
      );
    }

    if ((twilioAccountSid && !twilioAuthToken) || (!twilioAccountSid && twilioAuthToken)) {
      return NextResponse.json(
        { error: "twilioAccountSid and twilioAuthToken must be provided together" },
        { status: 400 }
      );
    }

    const tenant = await createTenant({
      id: slug,
      name: name.trim(),
      subdomain: slug,
      licenseExpiresAt: licenseExpiresAt || null,
      twilioWhatsappNumber: whatsappNumber ? `whatsapp:${whatsappNumber.trim()}` : null,
      twilioAccountSid: twilioAccountSid?.trim() || null,
      twilioAuthToken: twilioAuthToken?.trim() || null,
    });

    const rootDomain = process.env.TENANT_ROOT_DOMAIN;
    const url = rootDomain ? `https://${slug}.${rootDomain}` : null;

    return NextResponse.json({ tenant, url }, { status: 201 });
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505") {
      const message = pgErr.constraint?.includes("whatsapp")
        ? "That WhatsApp number is already assigned to another tenant"
        : "That subdomain is already in use";
      return NextResponse.json({ error: message }, { status: 409 });
    }
    console.error("/api/admin/tenants POST failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
