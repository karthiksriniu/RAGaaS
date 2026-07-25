import { NextRequest, NextResponse } from "next/server";
import { isAdminSession } from "@/lib/adminAuth";
import { listTenants, createTenant } from "@/lib/tenants";

export const runtime = "nodejs";

// staging is reserved specifically because a production tenant subdomain of
// "staging" would collide with staging.mybizcare.com, the staging
// environment's own wildcard.
const RESERVED_SUBDOMAINS = new Set(["www", "admin", "api", "staging"]);
const SUBDOMAIN_PATTERN = /^[a-z0-9-]{1,63}$/;

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
    const { name, subdomain, licenseExpiresAt } = await req.json();

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

    const tenant = await createTenant({
      id: slug,
      name: name.trim(),
      subdomain: slug,
      licenseExpiresAt: licenseExpiresAt || null,
    });

    const rootDomain = process.env.TENANT_ROOT_DOMAIN;
    const url = rootDomain ? `https://${slug}.${rootDomain}` : null;

    return NextResponse.json({ tenant, url }, { status: 201 });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      return NextResponse.json({ error: "That subdomain is already in use" }, { status: 409 });
    }
    console.error("/api/admin/tenants POST failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
