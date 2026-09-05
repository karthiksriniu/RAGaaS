import { NextRequest, NextResponse } from "next/server";
import { checkWorkerToken } from "@/lib/workerAuth";
import { checkRateLimit } from "@/lib/rateLimit";
import { assertTenantLicensed, TenantExpiredError, TenantNotFoundError } from "@/lib/tenants";
import { bookAppointment, getSchedulingConfig } from "@/lib/appointments";
import { daysAhead, formatIstTime, isOnGrid, isStandardDuration, utcToIst } from "@/lib/scheduling";
import { normalizeMobile } from "@/lib/mobile";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = checkWorkerToken(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });

  if (!(await checkRateLimit(`voice-book:${tenantId}`, 60_000, 60))) {
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
  if (!config.enabled) return NextResponse.json({ error: "Appointments are not enabled" }, { status: 409 });

  const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
  if (!resourceId) return NextResponse.json({ error: "resourceId is required" }, { status: 400 });

  const startsAt = new Date(String(body.startsAt ?? ""));
  if (Number.isNaN(startsAt.getTime())) {
    return NextResponse.json({ error: "startsAt must be an ISO timestamp" }, { status: 400 });
  }
  // Refused rather than rounded: nudging a caller's time silently would confirm
  // one appointment out loud and write another.
  if (!isOnGrid(startsAt)) {
    return NextResponse.json({ error: "startsAt must be on a 15-minute boundary" }, { status: 400 });
  }

  // Re-checked here, not just in availability. The tool could pass anything,
  // and a rule enforced only where it is offered is not enforced.
  const now = new Date();
  if (startsAt.getTime() < now.getTime() + config.leadMinutes * 60_000) {
    return NextResponse.json(
      { ok: false, reason: "too_soon", leadMinutes: config.leadMinutes },
      { status: 409 }
    );
  }
  if (daysAhead(utcToIst(startsAt).day, now) > config.windowDays) {
    return NextResponse.json(
      { ok: false, reason: "out_of_window", windowDays: config.windowDays },
      { status: 409 }
    );
  }

  const durationMinutes = isStandardDuration(body.durationMinutes)
    ? body.durationMinutes
    : config.defaultMinutes;

  // The number the agent read back and the caller confirmed. Normalised here
  // because it was spoken, so it arrives however the model transcribed it.
  const customerPhone = normalizeMobile(String(body.customerPhone ?? ""));
  if (!customerPhone) {
    return NextResponse.json({ error: "A valid customerPhone is required" }, { status: 400 });
  }

  const result = await bookAppointment(tenantId, {
    resourceId,
    startsAt,
    durationMinutes,
    customerPhone,
    customerName: typeof body.customerName === "string" ? body.customerName.trim().slice(0, 120) : null,
    partySize: Number.isInteger(body.partySize) && body.partySize > 0 ? Math.min(body.partySize, 50) : 1,
    service: typeof body.service === "string" ? body.service.trim().slice(0, 200) : null,
    notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : null,
    source: "voice",
  });

  if (!result.ok) {
    // A normal outcome, not an error: someone else took it. 409 so the agent
    // can tell them plainly and offer the next time.
    return NextResponse.json({ ok: false, reason: "taken" }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    appointmentId: result.appointment.id,
    startsAt: result.appointment.startsAt,
    spoken: formatIstTime(new Date(result.appointment.startsAt)),
  });
}
