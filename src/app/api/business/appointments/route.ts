import { NextRequest, NextResponse } from "next/server";
import { businessTenantId } from "@/lib/businessAuth";
import {
  bookAppointment, cancelAppointment, listAppointments, utilisationFor, getSchedulingConfig,
  rescheduleAppointment,
} from "@/lib/appointments";
import { isOnGrid, isStandardDuration, istDaysBetween, utcToIst } from "@/lib/scheduling";
import { normalizeMobile } from "@/lib/mobile";

export const runtime = "nodejs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const today = utcToIst(new Date()).day;
  const from = DAY.test(req.nextUrl.searchParams.get("from") || "") ? req.nextUrl.searchParams.get("from")! : today;
  const to = DAY.test(req.nextUrl.searchParams.get("to") || "") ? req.nextUrl.searchParams.get("to")! : from;
  const resourceId = req.nextUrl.searchParams.get("resourceId") || undefined;

  const days = istDaysBetween(from, to);
  // Bounded so a hand-edited URL cannot ask for a decade and scan the table.
  if (days.length === 0 || days.length > 92) {
    return NextResponse.json({ error: "Range must be between 1 and 92 days" }, { status: 400 });
  }

  const [appointments, utilisation] = await Promise.all([
    listAppointments(tenantId, { fromDayISO: from, toDayISO: to, resourceId }),
    utilisationFor(tenantId, { days }),
  ]);

  return NextResponse.json({ from, to, appointments, utilisation });
}

/** A booking made by the business itself, from the dashboard - a walk-in, or
 * someone who phoned the owner directly. Same path and same guard as the
 * agent's, so the grid cannot disagree with itself. */
export async function POST(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const config = await getSchedulingConfig(tenantId);

  const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim() : "";
  if (!resourceId) return NextResponse.json({ error: "resourceId is required" }, { status: 400 });

  const startsAt = new Date(String(body.startsAt ?? ""));
  if (Number.isNaN(startsAt.getTime()) || !isOnGrid(startsAt)) {
    return NextResponse.json({ error: "startsAt must be on a 15-minute boundary" }, { status: 400 });
  }

  const customerPhone = normalizeMobile(String(body.customerPhone ?? ""));
  if (!customerPhone) return NextResponse.json({ error: "A valid customerPhone is required" }, { status: 400 });

  const result = await bookAppointment(tenantId, {
    resourceId, startsAt, customerPhone,
    durationMinutes: isStandardDuration(body.durationMinutes) ? body.durationMinutes : config.defaultMinutes,
    customerName: typeof body.customerName === "string" ? body.customerName.trim().slice(0, 120) : null,
    partySize: Number.isInteger(body.partySize) && body.partySize > 0 ? Math.min(body.partySize, 50) : 1,
    service: typeof body.service === "string" ? body.service.trim().slice(0, 200) : null,
    notes: typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : null,
    source: "dashboard",
  });

  if (!result.ok) return NextResponse.json({ error: "That slot has just been taken" }, { status: 409 });
  return NextResponse.json({ appointment: result.appointment });
}

/** Move a booking to another person or another time.
 *
 * Goes through the same slot guard as a new booking, so editing cannot be used
 * to put two people in the same chair. */
export async function PATCH(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Parameters<typeof rescheduleAppointment>[2] = {};
  if (typeof body.resourceId === "string" && body.resourceId.trim()) {
    patch.resourceId = body.resourceId.trim();
  }
  if (body.startsAt !== undefined) {
    const startsAt = new Date(String(body.startsAt));
    if (Number.isNaN(startsAt.getTime()) || !isOnGrid(startsAt)) {
      return NextResponse.json({ error: "startsAt must be on a 15-minute boundary" }, { status: 400 });
    }
    patch.startsAt = startsAt;
  }
  if (isStandardDuration(body.durationMinutes)) patch.durationMinutes = body.durationMinutes;
  if (typeof body.customerName === "string") patch.customerName = body.customerName.trim().slice(0, 120);
  if (typeof body.service === "string") patch.service = body.service.trim().slice(0, 200);

  const result = await rescheduleAppointment(tenantId, id, patch);
  if (!result.ok) {
    return result.reason === "taken"
      ? NextResponse.json({ error: "That slot is already taken" }, { status: 409 })
      : NextResponse.json({ error: "Appointment not found" }, { status: 404 });
  }
  return NextResponse.json({ appointment: result.appointment });
}

export async function DELETE(req: NextRequest) {
  const tenantId = businessTenantId(req);
  if (!tenantId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const cancelled = await cancelAppointment(tenantId, id);
  if (!cancelled) return NextResponse.json({ error: "Not found or already cancelled" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
