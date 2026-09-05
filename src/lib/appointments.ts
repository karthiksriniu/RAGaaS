import { randomBytes } from "crypto";
import { pool, withTenant } from "@/lib/db";
import {
  SLOT_MINUTES,
  availableStarts,
  effectiveHours,
  istToUtc,
  istWeekday,
  openSlotCount,
  slotStartsFor,
  utcToIst,
  utilisation,
} from "@/lib/scheduling";

// The DB-backed half of scheduling. The pure half - grid arithmetic, IST,
// utilisation - is in scheduling.ts and is where the tests live.

/** Postgres unique_violation. This is not an error condition here: it IS the
 * double-booking guard reporting that it worked. */
const UNIQUE_VIOLATION = "23505";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newId(prefix: string): string {
  let out = prefix;
  for (const b of randomBytes(12)) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export type ResourceKind = "person" | "table" | "room" | "other";

export interface Resource {
  id: string;
  name: string;
  kind: ResourceKind;
  capacity: number;
  active: boolean;
  sortOrder: number;
}

export interface ResourceHours {
  weekday: number;
  opensMinute: number;
  closesMinute: number;
}

export interface Appointment {
  id: string;
  resourceId: string;
  resourceName?: string;
  startsAt: string;
  durationMinutes: number;
  customerName: string | null;
  customerPhone: string;
  partySize: number;
  service: string | null;
  notes: string | null;
  status: string;
  source: string;
  createdAt: string;
}

interface ResourceRow {
  id: string; name: string; kind: ResourceKind; capacity: number;
  active: boolean; sort_order: number;
}

function mapResource(r: ResourceRow): Resource {
  return { id: r.id, name: r.name, kind: r.kind, capacity: r.capacity, active: r.active, sortOrder: r.sort_order };
}

export async function listResources(tenantId: string, includeInactive = false): Promise<Resource[]> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query<ResourceRow>(
      `SELECT id, name, kind, capacity, active, sort_order FROM resources
        WHERE ($1 OR active) ORDER BY sort_order, name`,
      [includeInactive]
    );
    return res.rows.map(mapResource);
  });
}

export async function createResource(tenantId: string, input: {
  name: string; kind?: ResourceKind; capacity?: number; sortOrder?: number;
}): Promise<Resource> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query<ResourceRow>(
      `INSERT INTO resources (id, tenant_id, name, kind, capacity, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, kind, capacity, active, sort_order`,
      [newId("res_"), tenantId, input.name.trim(), input.kind ?? "person",
       input.capacity ?? 1, input.sortOrder ?? 0]
    );
    return mapResource(res.rows[0]);
  });
}

export async function updateResource(tenantId: string, id: string, patch: {
  name?: string; kind?: ResourceKind; capacity?: number; active?: boolean; sortOrder?: number;
}): Promise<Resource | null> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query<ResourceRow>(
      `UPDATE resources SET
         name       = coalesce($3, name),
         kind       = coalesce($4, kind),
         capacity   = coalesce($5, capacity),
         active     = coalesce($6, active),
         sort_order = coalesce($7, sort_order)
       WHERE id = $2 AND tenant_id = $1
       RETURNING id, name, kind, capacity, active, sort_order`,
      [tenantId, id, patch.name?.trim() ?? null, patch.kind ?? null,
       patch.capacity ?? null, patch.active ?? null, patch.sortOrder ?? null]
    );
    return res.rows[0] ? mapResource(res.rows[0]) : null;
  });
}

export async function getHours(tenantId: string, resourceId: string): Promise<ResourceHours[]> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query<{ weekday: number; opens_minute: number; closes_minute: number }>(
      `SELECT weekday, opens_minute, closes_minute FROM resource_hours
        WHERE resource_id = $1 ORDER BY weekday`,
      [resourceId]
    );
    return res.rows.map((r) => ({
      weekday: r.weekday, opensMinute: r.opens_minute, closesMinute: r.closes_minute,
    }));
  });
}

/** Replaces the whole week in one transaction.
 *
 * Whole-week replace rather than per-day upsert because a missing row MEANS
 * closed: editing day by day leaves no way to express "we stopped opening on
 * Sundays" without a delete the caller has to remember to send. */
export async function setHours(tenantId: string, resourceId: string, hours: ResourceHours[]): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query("DELETE FROM resource_hours WHERE resource_id = $1", [resourceId]);
    for (const h of hours) {
      if (h.closesMinute <= h.opensMinute) continue;
      await c.query(
        `INSERT INTO resource_hours (tenant_id, resource_id, weekday, opens_minute, closes_minute)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, resourceId, h.weekday, h.opensMinute, h.closesMinute]
      );
    }
  });
}

/** The business's own opening hours - the default every resource inherits. */
export async function getTenantHours(tenantId: string): Promise<ResourceHours[]> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query<{ weekday: number; opens_minute: number; closes_minute: number }>(
      "SELECT weekday, opens_minute, closes_minute FROM tenant_hours ORDER BY weekday"
    );
    return res.rows.map((r) => ({
      weekday: r.weekday, opensMinute: r.opens_minute, closesMinute: r.closes_minute,
    }));
  });
}

export async function setTenantHours(tenantId: string, hours: ResourceHours[]): Promise<void> {
  await withTenant(tenantId, async (c) => {
    await c.query("DELETE FROM tenant_hours WHERE tenant_id = $1", [tenantId]);
    for (const h of hours) {
      if (h.closesMinute <= h.opensMinute) continue;
      await c.query(
        `INSERT INTO tenant_hours (tenant_id, weekday, opens_minute, closes_minute)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, h.weekday, h.opensMinute, h.closesMinute]
      );
    }
  });
}

export interface BookingRequest {
  resourceId: string;
  startsAt: Date;
  durationMinutes: number;
  customerPhone: string;
  customerName?: string | null;
  partySize?: number;
  service?: string | null;
  notes?: string | null;
  source?: "voice" | "dashboard";
}

export type BookingResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "taken" };

/** Books, or reports that the slot went while we were asking.
 *
 * One transaction, no prior availability check: the appointment row and its
 * slot rows go in together, and if any slot is already claimed the primary key
 * on appointment_slots rejects the lot. Checking first would be both slower -
 * two round trips on a Virginia-to-Tokyo hop, mid-call - and wrong, since
 * another caller can book between the check and the insert.
 *
 * "taken" is a normal outcome, not an error: the agent offers the next time. */
export async function bookAppointment(tenantId: string, req: BookingRequest): Promise<BookingResult> {
  const slots = slotStartsFor(req.startsAt, req.durationMinutes);
  const id = newId("apt_");

  try {
    const appointment = await withTenant(tenantId, async (c) => {
      const res = await c.query<{
        id: string; resource_id: string; starts_at: string; duration_minutes: number;
        customer_name: string | null; customer_phone: string; party_size: number;
        service: string | null; notes: string | null; status: string; source: string; created_at: string;
      }>(
        `INSERT INTO appointments
           (id, tenant_id, resource_id, starts_at, duration_minutes, customer_name,
            customer_phone, party_size, service, notes, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [id, tenantId, req.resourceId, req.startsAt.toISOString(), req.durationMinutes,
         req.customerName ?? null, req.customerPhone, req.partySize ?? 1,
         req.service ?? null, req.notes ?? null, req.source ?? "voice"]
      );

      // unnest, so the whole grid goes in as one statement rather than one
      // round trip per quarter hour.
      await c.query(
        `INSERT INTO appointment_slots (tenant_id, appointment_id, resource_id, slot_start)
         SELECT $1, $2, $3, unnest($4::timestamptz[])`,
        [tenantId, id, req.resourceId, slots.map((d) => d.toISOString())]
      );

      const r = res.rows[0];
      return {
        id: r.id, resourceId: r.resource_id, startsAt: r.starts_at,
        durationMinutes: r.duration_minutes, customerName: r.customer_name,
        customerPhone: r.customer_phone, partySize: r.party_size, service: r.service,
        notes: r.notes, status: r.status, source: r.source, createdAt: r.created_at,
      } satisfies Appointment;
    });
    return { ok: true, appointment };
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return { ok: false, reason: "taken" };
    throw err;
  }
}

/** Cancelling frees the grid by DELETING the slot rows - the appointment row
 * stays for the record. */
export async function cancelAppointment(tenantId: string, id: string): Promise<boolean> {
  return withTenant(tenantId, async (c) => {
    const res = await c.query(
      "UPDATE appointments SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2 AND status = 'booked'",
      [id, tenantId]
    );
    if (res.rowCount === 0) return false;
    await c.query("DELETE FROM appointment_slots WHERE appointment_id = $1", [id]);
    return true;
  });
}

export interface AvailabilityQuery {
  resourceId?: string;
  dayISO: string;
  durationMinutes: number;
  limitPerResource?: number;
  now?: Date;
}

export interface ResourceAvailability {
  resource: Resource;
  starts: Date[];
}

/** Free start times for a day, per resource.
 *
 * Reads the day's taken slots in ONE query across all resources rather than per
 * resource: this runs while a caller waits, and the round trip dominates. */
export async function availabilityForDay(
  tenantId: string,
  query: AvailabilityQuery
): Promise<ResourceAvailability[]> {
  const weekday = istWeekday(query.dayISO);
  // Widened by a day at each end so a booking that began before midnight and
  // runs into this day still blocks its slots.
  const from = istToUtc(query.dayISO, -SLOT_MINUTES * 4);
  const to = istToUtc(query.dayISO, 1440 + SLOT_MINUTES * 8);

  const { resources, hours, taken, overrides, tenantHours } = await withTenant(tenantId, async (c) => {
    const resRows = await c.query<ResourceRow>(
      `SELECT id, name, kind, capacity, active, sort_order FROM resources
        WHERE active AND ($1::text IS NULL OR id = $1) ORDER BY sort_order, name`,
      [query.resourceId ?? null]
    );
    const hourRows = await c.query<{ resource_id: string; opens_minute: number; closes_minute: number }>(
      `SELECT resource_id, opens_minute, closes_minute FROM resource_hours WHERE weekday = $1`,
      [weekday]
    );
    // Which resources override at all - not which override today. See
    // effectiveHours for why that distinction is load-bearing.
    const overrideRows = await c.query<{ resource_id: string }>(
      "SELECT DISTINCT resource_id FROM resource_hours"
    );
    const tenantHourRows = await c.query<{ opens_minute: number; closes_minute: number }>(
      "SELECT opens_minute, closes_minute FROM tenant_hours WHERE weekday = $1",
      [weekday]
    );
    const takenRows = await c.query<{ resource_id: string; slot_start: string }>(
      `SELECT resource_id, slot_start FROM appointment_slots
        WHERE slot_start >= $1 AND slot_start < $2`,
      [from.toISOString(), to.toISOString()]
    );
    return {
      resources: resRows.rows, hours: hourRows.rows, taken: takenRows.rows,
      overrides: overrideRows.rows, tenantHours: tenantHourRows.rows[0],
    };
  });

  const overrideIds = new Set(overrides.map((o) => o.resource_id));
  const businessHours = tenantHours
    ? { opens: tenantHours.opens_minute, closes: tenantHours.closes_minute }
    : undefined;
  const hoursBy = new Map(hours.map((h) => [h.resource_id, h]));
  const takenBy = new Map<string, Set<number>>();
  for (const t of taken) {
    if (!takenBy.has(t.resource_id)) takenBy.set(t.resource_id, new Set());
    takenBy.get(t.resource_id)!.add(new Date(t.slot_start).getTime());
  }

  return resources.map((row) => {
    const own = hoursBy.get(row.id);
    // No applicable hours means closed - the whole reason absence is the
    // encoding, so there is no flag here that can disagree with the times.
    const h = effectiveHours(
      overrideIds.has(row.id),
      own ? { opens: own.opens_minute, closes: own.closes_minute } : undefined,
      businessHours
    );
    const starts = h
      ? availableStarts({
          dayISO: query.dayISO,
          opensMinute: h.opens,
          closesMinute: h.closes,
          durationMinutes: query.durationMinutes,
          takenSlotMs: takenBy.get(row.id) ?? new Set(),
          now: query.now,
          limit: query.limitPerResource,
        })
      : [];
    return { resource: mapResource(row), starts };
  });
}

export async function listAppointments(tenantId: string, opts: {
  fromDayISO: string; toDayISO: string; resourceId?: string;
}): Promise<Appointment[]> {
  const from = istToUtc(opts.fromDayISO, 0);
  const to = istToUtc(opts.toDayISO, 1440);
  return withTenant(tenantId, async (c) => {
    const res = await c.query<{
      id: string; resource_id: string; resource_name: string; starts_at: string;
      duration_minutes: number; customer_name: string | null; customer_phone: string;
      party_size: number; service: string | null; notes: string | null;
      status: string; source: string; created_at: string;
    }>(
      `SELECT a.*, r.name AS resource_name
         FROM appointments a JOIN resources r ON r.id = a.resource_id
        WHERE a.starts_at >= $1 AND a.starts_at < $2
          AND ($3::text IS NULL OR a.resource_id = $3)
        ORDER BY a.starts_at`,
      [from.toISOString(), to.toISOString(), opts.resourceId ?? null]
    );
    return res.rows.map((r) => ({
      id: r.id, resourceId: r.resource_id, resourceName: r.resource_name,
      startsAt: r.starts_at, durationMinutes: r.duration_minutes,
      customerName: r.customer_name, customerPhone: r.customer_phone,
      partySize: r.party_size, service: r.service, notes: r.notes,
      status: r.status, source: r.source, createdAt: r.created_at,
    }));
  });
}

export interface UtilisationRow {
  resource: Resource;
  bookedSlots: number;
  openSlots: number;
  /** null when the resource was never open in the period - which is a different
   * fact from "open and nobody booked". */
  ratio: number | null;
}

export async function utilisationFor(tenantId: string, opts: {
  days: string[];
}): Promise<UtilisationRow[]> {
  if (opts.days.length === 0) return [];
  const from = istToUtc(opts.days[0], 0);
  const to = istToUtc(opts.days[opts.days.length - 1], 1440);

  const { resources, hours, taken, tenantHours } = await withTenant(tenantId, async (c) => {
    const resRows = await c.query<ResourceRow>(
      `SELECT id, name, kind, capacity, active, sort_order FROM resources
        WHERE active ORDER BY sort_order, name`
    );
    const hourRows = await c.query<{ resource_id: string; weekday: number; opens_minute: number; closes_minute: number }>(
      "SELECT resource_id, weekday, opens_minute, closes_minute FROM resource_hours"
    );
    const tenantHourRows = await c.query<{ weekday: number; opens_minute: number; closes_minute: number }>(
      "SELECT weekday, opens_minute, closes_minute FROM tenant_hours"
    );
    const takenRows = await c.query<{ resource_id: string; n: string }>(
      `SELECT resource_id, count(*)::text AS n FROM appointment_slots
        WHERE slot_start >= $1 AND slot_start < $2 GROUP BY resource_id`,
      [from.toISOString(), to.toISOString()]
    );
    return { resources: resRows.rows, hours: hourRows.rows, taken: takenRows.rows,
             tenantHours: tenantHourRows.rows };
  });

  const bookedBy = new Map(taken.map((t) => [t.resource_id, Number(t.n)]));
  const businessWeek = new Map(tenantHours.map((h) => [h.weekday, { opens: h.opens_minute, closes: h.closes_minute }]));
  const hoursBy = new Map<string, Map<number, { opens: number; closes: number }>>();
  for (const h of hours) {
    if (!hoursBy.has(h.resource_id)) hoursBy.set(h.resource_id, new Map());
    hoursBy.get(h.resource_id)!.set(h.weekday, { opens: h.opens_minute, closes: h.closes_minute });
  }

  return resources.map((row) => {
    const week = hoursBy.get(row.id);
    let openSlots = 0;
    for (const day of opts.days) {
      const h = effectiveHours(Boolean(week), week?.get(istWeekday(day)), businessWeek.get(istWeekday(day)));
      if (h) openSlots += openSlotCount(h.opens, h.closes);
    }
    const bookedSlots = bookedBy.get(row.id) ?? 0;
    return { resource: mapResource(row), bookedSlots, openSlots, ratio: utilisation(bookedSlots, openSlots) };
  });
}

/** Per-tenant scheduling settings, read straight from tenants. */
export async function getSchedulingConfig(tenantId: string): Promise<{
  enabled: boolean; defaultMinutes: number; windowDays: number; leadMinutes: number;
}> {
  const res = await pool.query<{
    appointments_enabled: boolean; appointment_default_minutes: number;
    booking_window_days: number; booking_lead_minutes: number;
  }>(
    `SELECT appointments_enabled, appointment_default_minutes,
            booking_window_days, booking_lead_minutes
       FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const row = res.rows[0];
  return {
    enabled: Boolean(row?.appointments_enabled),
    defaultMinutes: row?.appointment_default_minutes ?? 30,
    windowDays: row?.booking_window_days ?? 30,
    leadMinutes: row?.booking_lead_minutes ?? 60,
  };
}

/** Mon-Sat, 10am-8pm. Not a guess at any particular business, just a week that
 * is obviously editable and obviously not "closed forever". */
const DEFAULT_WEEK: ResourceHours[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, opensMinute: 600, closesMinute: 1200,
}));

/** Gives a tenant a working week if it has none.
 *
 * Called when appointments are switched on, because "enabled with no hours" is
 * a state that looks configured and behaves as permanently closed: every
 * resource inherits the business hours, no hours means closed, and the agent
 * tells every caller that nobody is ever available. That is exactly what
 * happened on 5 Sep - the dashboard displayed a default week it had never
 * saved, so the screen looked right and the database was empty. */
export async function ensureDefaultHours(tenantId: string): Promise<boolean> {
  const existing = await getTenantHours(tenantId);
  if (existing.length > 0) return false;
  await setTenantHours(tenantId, DEFAULT_WEEK);
  return true;
}

export async function setSchedulingConfig(tenantId: string, patch: {
  enabled?: boolean; defaultMinutes?: number; windowDays?: number; leadMinutes?: number;
}): Promise<void> {
  await pool.query(
    `UPDATE tenants SET
       appointments_enabled = coalesce($2, appointments_enabled),
       appointment_default_minutes = coalesce($3, appointment_default_minutes),
       booking_window_days = coalesce($4, booking_window_days),
       booking_lead_minutes = coalesce($5, booking_lead_minutes)
     WHERE id = $1`,
    [tenantId, patch.enabled ?? null, patch.defaultMinutes ?? null,
     patch.windowDays ?? null, patch.leadMinutes ?? null]
  );
}

export { utcToIst };
