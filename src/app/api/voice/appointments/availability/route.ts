import { NextRequest, NextResponse } from "next/server";
import { checkWorkerToken } from "@/lib/workerAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { assertTenantLicensed, TenantExpiredError, TenantNotFoundError } from "@/lib/tenants";
import { availabilityForDay, getSchedulingConfig } from "@/lib/appointments";
import { formatIstTime, isStandardDuration, utcToIst } from "@/lib/scheduling";

export const runtime = "nodejs";

// Called mid-call, so it answers in words the agent can say rather than in
// timestamps it would have to render itself. See the latency note in
// /api/voice/retrieve - this does one database round trip, deliberately.

export async function POST(req: NextRequest) {
  const auth = checkWorkerToken(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });

  if (!(await checkRateLimit(`voice-availability:${tenantId}`, 60_000, 120))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    await assertTenantLicensed(tenantId);
  } catch (err) {
    if (err instanceof TenantNotFoundError) return NextResponse.json({ error: "Unknown tenant" }, { status: 404 });
    if (err instanceof TenantExpiredError) return NextResponse.json({ error: "Licence expired" }, { status: 403 });
    throw err;
  }

  const config = await getSchedulingConfig(tenantId);
  if (!config.enabled) {
    return NextResponse.json({ enabled: false, spoken: "", options: [] });
  }

  // Default to today in IST, not the server's idea of today.
  const dayISO = typeof body.dayISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dayISO)
    ? body.dayISO
    : utcToIst(new Date()).day;

  const durationMinutes = isStandardDuration(body.durationMinutes)
    ? body.durationMinutes
    : config.defaultMinutes;

  const perResource = await availabilityForDay(tenantId, {
    dayISO,
    resourceId: typeof body.resourceId === "string" ? body.resourceId : undefined,
    durationMinutes,
    // Three each: a caller cannot hold more than that in their head, and the
    // agent reading a dozen times is worse than useless.
    limitPerResource: 3,
  });

  const options = perResource.flatMap(({ resource, starts }) =>
    starts.map((s) => ({
      resourceId: resource.id,
      resourceName: resource.name,
      capacity: resource.capacity,
      startsAt: s.toISOString(),
      spoken: formatIstTime(s),
    }))
  );

  // Pre-composed so the model has something to say rather than a list to
  // narrate - the same reasoning as search_knowledge_base returning framed text.
  const spoken = options.length
    ? perResource
        .filter((r) => r.starts.length)
        .map((r) => `${r.resource.name}: ${r.starts.map(formatIstTime).join(", ")}`)
        .join("; ")
    : "";

  return NextResponse.json({
    enabled: true, dayISO, durationMinutes, options, spoken,
    none: options.length === 0,
  });
}
