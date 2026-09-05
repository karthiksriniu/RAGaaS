import { NextRequest, NextResponse } from "next/server";
import { businessTenantId } from "@/lib/businessAuth";
import { createResource, listResources, type ResourceKind } from "@/lib/appointments";

export const runtime = "nodejs";

const KINDS: ResourceKind[] = ["person", "table", "room", "other"];

export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ resources: await listResources(tenantId, true) });
}

export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  const kind: ResourceKind = KINDS.includes(body.kind) ? body.kind : "person";
  const capacity =
    Number.isInteger(body.capacity) && body.capacity > 0 ? Math.min(body.capacity, 100) : 1;

  return NextResponse.json({
    resource: await createResource(tenantId, {
      name, kind, capacity,
      sortOrder: Number.isInteger(body.sortOrder) ? body.sortOrder : 0,
    }),
  });
}
