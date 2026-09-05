import { NextRequest, NextResponse } from "next/server";
import { businessTenantId } from "@/lib/businessAuth";
import {
  getSchedulingConfig, setSchedulingConfig, listResources, getHours,
  getTenantHours, setTenantHours, ensureDefaultHours, type ResourceHours,
} from "@/lib/appointments";
import { isStandardDuration, STANDARD_DURATIONS } from "@/lib/scheduling";

export const runtime = "nodejs";

/** Everything the Appointments tab needs to render, in one request - config,
 * resources and each resource's week. Three round trips to Tokyo to paint one
 * screen is three times the wait. */
export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [config, resources, businessHours] = await Promise.all([
    getSchedulingConfig(tenantId),
    listResources(tenantId, true),
    getTenantHours(tenantId),
  ]);
  const hours = await Promise.all(
    resources.map(async (r) => ({ resourceId: r.id, hours: await getHours(tenantId, r.id) }))
  );

  return NextResponse.json({
    ...config,
    durations: STANDARD_DURATIONS,
    businessHours,
    resources,
    hours: Object.fromEntries(hours.map((h) => [h.resourceId, h.hours])),
  });
}

export async function PATCH(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const patch: { enabled?: boolean; defaultMinutes?: number; windowDays?: number; leadMinutes?: number } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.defaultMinutes !== undefined) {
    if (!isStandardDuration(body.defaultMinutes)) {
      return NextResponse.json(
        { error: `defaultMinutes must be one of ${STANDARD_DURATIONS.join(", ")}` },
        { status: 400 }
      );
    }
    patch.defaultMinutes = body.defaultMinutes;
  }
  // Bounded rather than free: a window of 3650 days is not a preference, it is
  // a typo, and the agent would cheerfully offer a slot in 2036.
  if (body.windowDays !== undefined) {
    if (!Number.isInteger(body.windowDays) || body.windowDays < 1 || body.windowDays > 365) {
      return NextResponse.json({ error: "windowDays must be between 1 and 365" }, { status: 400 });
    }
    patch.windowDays = body.windowDays;
  }
  if (body.leadMinutes !== undefined) {
    if (!Number.isInteger(body.leadMinutes) || body.leadMinutes < 0 || body.leadMinutes > 1440) {
      return NextResponse.json({ error: "leadMinutes must be between 0 and 1440" }, { status: 400 });
    }
    patch.leadMinutes = body.leadMinutes;
  }

  // Business hours ride along with the config because they are edited on the
  // same screen; splitting them would let a save half-apply.
  if (Array.isArray(body.businessHours)) {
    const hours: ResourceHours[] = [];
    for (const raw of body.businessHours as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const h = raw as Record<string, unknown>;
      if (!Number.isInteger(h.weekday) || !Number.isInteger(h.opensMinute) || !Number.isInteger(h.closesMinute)) continue;
      const w = h.weekday as number, o = h.opensMinute as number, c = h.closesMinute as number;
      if (w < 0 || w > 6 || o < 0 || o >= 1440 || c <= o || c > 1740) continue;
      hours.push({ weekday: w, opensMinute: o, closesMinute: c });
    }
    await setTenantHours(tenantId, hours);
  }

  await setSchedulingConfig(tenantId, patch);
  // Switching it on with no hours stored means enabled-and-closed-forever, so
  // seed a week rather than leave a business whose agent refuses every caller.
  if (patch.enabled === true) await ensureDefaultHours(tenantId);
  return NextResponse.json({
    ...(await getSchedulingConfig(tenantId)),
    businessHours: await getTenantHours(tenantId),
  });
}
