import { NextRequest, NextResponse } from "next/server";
import { businessTenantId } from "@/lib/businessAuth";
import { getSchedulingConfig, setSchedulingConfig, listResources, getHours } from "@/lib/appointments";
import { isStandardDuration, STANDARD_DURATIONS } from "@/lib/scheduling";

export const runtime = "nodejs";

/** Everything the Appointments tab needs to render, in one request - config,
 * resources and each resource's week. Three round trips to Tokyo to paint one
 * screen is three times the wait. */
export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [config, resources] = await Promise.all([
    getSchedulingConfig(tenantId),
    listResources(tenantId, true),
  ]);
  const hours = await Promise.all(
    resources.map(async (r) => ({ resourceId: r.id, hours: await getHours(tenantId, r.id) }))
  );

  return NextResponse.json({
    ...config,
    durations: STANDARD_DURATIONS,
    resources,
    hours: Object.fromEntries(hours.map((h) => [h.resourceId, h.hours])),
  });
}

export async function PATCH(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const patch: { enabled?: boolean; defaultMinutes?: number } = {};
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

  await setSchedulingConfig(tenantId, patch);
  return NextResponse.json(await getSchedulingConfig(tenantId));
}
