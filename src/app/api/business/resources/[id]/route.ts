import { NextRequest, NextResponse } from "next/server";
import { businessTenantId } from "@/lib/businessAuth";
import { getHours, setHours, updateResource, type ResourceHours, type ResourceKind } from "@/lib/appointments";

export const runtime = "nodejs";

const KINDS: ResourceKind[] = ["person", "table", "room", "other"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const patch: Parameters<typeof updateResource>[2] = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (KINDS.includes(body.kind)) patch.kind = body.kind;
  if (Number.isInteger(body.capacity) && body.capacity > 0) patch.capacity = Math.min(body.capacity, 100);
  if (typeof body.active === "boolean") patch.active = body.active;
  if (Number.isInteger(body.sortOrder)) patch.sortOrder = body.sortOrder;

  // Hours arrive alongside the resource because the dashboard edits them on one
  // screen; sending them separately would let a save half-apply.
  if (Array.isArray(body.hours)) {
    // Built up explicitly rather than chained filters: the input is JSON, so it
    // is `any` all the way down, and a predicate that TypeScript cannot follow
    // is a validation everyone assumes happened. The bounds mirror the CHECK
    // constraints in migration 011 so a bad row is refused here with a message
    // rather than as a 500 from Postgres.
    const hours: ResourceHours[] = [];
    for (const raw of body.hours as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const h = raw as Record<string, unknown>;
      const weekday = h.weekday, opensMinute = h.opensMinute, closesMinute = h.closesMinute;
      if (!Number.isInteger(weekday) || !Number.isInteger(opensMinute) || !Number.isInteger(closesMinute)) continue;
      const w = weekday as number, o = opensMinute as number, c = closesMinute as number;
      if (w < 0 || w > 6) continue;
      if (o < 0 || o >= 1440) continue;
      if (c <= o || c > 1740) continue;
      hours.push({ weekday: w, opensMinute: o, closesMinute: c });
    }
    await setHours(tenantId, id, hours);
  }

  const resource = await updateResource(tenantId, id, patch);
  if (!resource) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ resource, hours: await getHours(tenantId, id) });
}
