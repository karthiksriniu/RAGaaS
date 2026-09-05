import { NextRequest, NextResponse } from "next/server";
import { checkWorkerToken } from "@/lib/workerAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { assertTenantLicensed, TenantExpiredError, TenantNotFoundError } from "@/lib/tenants";
import { availabilityForDay, getSchedulingConfig } from "@/lib/appointments";
import {
  daysAhead, formatIstDate, formatIstTime, isStandardDuration, istToUtc,
  nearestStarts, needsDateConfirmation, parseSpokenTime, utcToIst,
} from "@/lib/scheduling";

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

  const now = new Date();
  const ahead = daysAhead(dayISO, now);
  if (ahead < 0) {
    return NextResponse.json({ enabled: true, dayISO, past: true, options: [], spoken: "" });
  }
  if (ahead > config.windowDays) {
    return NextResponse.json({
      enabled: true, dayISO, outOfWindow: true, windowDays: config.windowDays,
      options: [], spoken: "",
    });
  }

  // Nothing sooner than the lead time. Offering a slot fifteen minutes out is
  // offering one nobody can physically reach.
  const earliest = new Date(now.getTime() + config.leadMinutes * 60_000);

  const perResource = await availabilityForDay(tenantId, {
    dayISO,
    resourceId: typeof body.resourceId === "string" ? body.resourceId : undefined,
    durationMinutes,
    now: earliest,
    // Deliberately unlimited here: narrowing happens below, either around the
    // time the caller asked for or from the front. Capping first would throw
    // away the 6pm slot they wanted in favour of three at opening time.
  });

  // What they actually asked for, if they asked for anything. Null means "any
  // time", which is a real answer and must not become midnight.
  const preferred = parseSpokenTime(typeof body.preferredTime === "string" ? body.preferredTime : null);

  const narrowed = perResource.map(({ resource, starts }) => ({
    resource,
    starts: preferred === null ? starts.slice(0, 3) : nearestStarts(starts, preferred, 3),
  }));

  // Closed and fully booked both arrive as an empty list and are entirely
  // different things to tell a caller. "Fully booked" sends someone away to try
  // again for a day that will never have anything.
  const open = perResource.filter((r) => r.hours !== null);
  const closed = perResource.length > 0 && open.length === 0;

  // A time the business is simply not open for - also not "taken".
  const outsideHours =
    !closed && preferred !== null &&
    open.every((r) => preferred < r.hours!.opens || preferred + durationMinutes > r.hours!.closes);

  const hoursSpoken = open.length
    ? `${formatIstTime(istToUtc(dayISO, open[0].hours!.opens))} to ${formatIstTime(istToUtc(dayISO, open[0].hours!.closes))}`
    : null;

  const options = narrowed.flatMap(({ resource, starts }) =>
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
    ? narrowed
        .filter((r) => r.starts.length)
        .map((r) => `${r.resource.name}: ${r.starts.map(formatIstTime).join(", ")}`)
        .join("; ")
    : "";

  return NextResponse.json({
    enabled: true, dayISO, durationMinutes, options, spoken,
    closed,
    outsideHours,
    hoursSpoken,
    // So the agent can offer who IS here when the caller names someone who
    // isn't, rather than quietly booking them with a stranger.
    resourceNames: perResource.map((r) => r.resource.name),
    // Given to the agent rather than left for it to phrase. Unprompted it said
    // "aaravathu September" - the ordinal first - which is not a date anyone can
    // follow at conversational speed.
    daySpoken: formatIstDate(dayISO),
    none: options.length === 0,
    // Beyond a week, a time alone is ambiguous - the agent is told to say the
    // date back before booking.
    confirmDate: needsDateConfirmation(dayISO, now),
    // True when the caller named a time and these are the nearest instead, so
    // the agent says "the closest I have is..." rather than implying it is what
    // they asked for.
    nearestTo: preferred !== null && options.length > 0
      ? (typeof body.preferredTime === "string" ? body.preferredTime : null)
      : null,
  });
}
